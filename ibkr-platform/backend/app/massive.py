"""Massive market data: the underlying spot behind the payoff panel.

Massive is a Polygon-compatible vendor — REST at `https://api.massive.com`,
authenticated with an `apiKey` query parameter. This is a port of
US-Trading-Infra's `market_data/massive/rest.py`, kept deliberately close to it
so both projects resolve a spot the same way. In particular the loader order in
`LOADERS` is the one that project settled on: indices first, because a cash
index like SPX has no tradable ticker of its own and only appears under the
`I:` prefix, then progressively weaker sources ending at yesterday's close.

Adapted in two ways. The calls are async, because this process is an event loop
rather than that project's threaded producer; and prices are `Decimal`, matching
every other price in the domain model. The day high/low that project tracks are
dropped — nothing here consumes them.
"""

from __future__ import annotations

import asyncio
import csv
import json
import logging
import os
import tempfile
from dataclasses import dataclass
from datetime import UTC, date, datetime, time
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo

import httpx

from app.config import settings

log = logging.getLogger("app.massive")

SAMPLE_PREFIX = "market:massive"
CSV_FIELDS = ("timestamp_utc", "symbol", "price", "source")


class RateLimited(Exception):
    """The vendor refused for quota, not entitlement.

    Raised rather than returned because the loader chain must abort on it: every
    further loader would spend another request against an already-empty budget.
    Entry-level plans allow only a handful of requests a minute, so one 429 means
    the whole cycle is over.
    """

#: Cash indices have no tradable ticker; Massive prefixes them with `I:`.
INDEX_UNDERLYINGS = frozenset({"SPX", "NDX", "RUT", "VIX"})


def index_ticker(underlying: str) -> str | None:
    ul = underlying.upper()
    return f"I:{ul}" if ul in INDEX_UNDERLYINGS else None


def ticker_matches(underlying: str, ticker: str) -> bool:
    """Whether a snapshot row's ticker names this underlying.

    A blank ticker counts as a match: some snapshot rows omit it, and the row
    was already selected by an underlying-scoped path.
    """
    ul, given = underlying.upper(), (ticker or "").upper()
    if not given or given == ul:
        return True
    index = index_ticker(ul)
    return index is not None and given == index


@dataclass(frozen=True, slots=True)
class Spot:
    price: Decimal
    #: Which loader produced it, so a stale or surprising number is traceable.
    source: str


def _clock(value: str) -> time:
    return time.fromisoformat(value)


def session_day(at: datetime) -> date:
    """The New York trading date containing this timestamp."""
    return at.astimezone(ZoneInfo(settings.massive_session_timezone)).date()


def session_is_open(at: datetime) -> bool:
    local = at.astimezone(ZoneInfo(settings.massive_session_timezone))
    return (
        local.weekday() < 5
        and _clock(settings.massive_session_open) <= local.time().replace(tzinfo=None)
        < _clock(settings.massive_session_close)
    )


def sample_key(symbol: str, day: date) -> str:
    return f"{SAMPLE_PREFIX}:{symbol.upper()}:{day.isoformat()}:samples"


async def record_sample(redis, symbol: str, spot: Spot, *, at: datetime | None = None) -> None:
    """Append one successful quote to the symbol's dedicated session list."""
    moment = at or datetime.now(UTC)
    payload = {
        "timestamp_utc": moment.astimezone(UTC).isoformat(),
        "symbol": symbol.upper(),
        "price": str(spot.price),
        "source": spot.source,
    }
    await redis.rpush(sample_key(symbol, session_day(moment)), json.dumps(payload))


def _write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    """Merge and atomically replace a session CSV."""
    path.parent.mkdir(parents=True, exist_ok=True)
    merged: dict[tuple[str, str, str, str], dict[str, str]] = {}
    if path.exists():
        with path.open(newline="", encoding="utf-8") as existing:
            for row in csv.DictReader(existing):
                normalized = {field: row.get(field, "") for field in CSV_FIELDS}
                merged[tuple(normalized[field] for field in CSV_FIELDS)] = normalized
    for row in rows:
        normalized = {field: str(row.get(field, "")) for field in CSV_FIELDS}
        merged[tuple(normalized[field] for field in CSV_FIELDS)] = normalized
    ordered = sorted(merged.values(), key=lambda row: row["timestamp_utc"])
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", newline="", encoding="utf-8", dir=path.parent, delete=False
        ) as output:
            temporary = Path(output.name)
            writer = csv.DictWriter(output, fieldnames=CSV_FIELDS)
            writer.writeheader()
            writer.writerows(ordered)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


async def archive_due_samples(
    redis, symbol: str, *, at: datetime | None = None, directory: str | None = None
) -> list[Path]:
    """Archive closed sessions and delete only their isolated sample keys.

    A source key is renamed before it is read, so a late producer recreates the
    source key rather than losing a sample between LRANGE and DELETE.
    """
    moment = at or datetime.now(UTC)
    local = moment.astimezone(ZoneInfo(settings.massive_session_timezone))
    today = local.date()
    after_close = local.time().replace(tzinfo=None) >= _clock(settings.massive_session_close)
    archived = []
    pattern = f"{SAMPLE_PREFIX}:{symbol.upper()}:*:samples"
    async for key in redis.scan_iter(match=pattern):
        key = key.decode() if isinstance(key, bytes) else key
        try:
            day = date.fromisoformat(key.split(":")[-2])
        except (ValueError, IndexError):
            continue
        if day > today or (day == today and not after_close):
            continue
        staging = f"{key}:archiving:{uuid4()}"
        try:
            await redis.rename(key, staging)
        except Exception as exc:
            # Another collector may have moved the same global key first.
            if "no such key" in str(exc).lower():
                continue
            raise
        raw_rows = await redis.lrange(staging, 0, -1)
        rows = [json.loads(row) for row in raw_rows]
        target = Path(directory or settings.massive_archive_directory) / symbol.upper()
        target /= f"{symbol.upper()}_{day.isoformat()}.csv"
        try:
            await asyncio.to_thread(_write_csv, target, rows)
        except Exception:
            # Restore the batch for retry; never flush data before a durable CSV.
            await redis.rename(staging, key)
            raise
        await redis.delete(staging)
        archived.append(target)
        log.info("massive.session_archived symbol=%s rows=%s path=%s", symbol, len(rows), target)
    return archived


def _price(value: Any) -> Decimal | None:
    """A positive Decimal, or None for anything unusable."""
    if value is None:
        return None
    try:
        price = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return price if price > 0 else None


async def get_json(
    client: httpx.AsyncClient, path: str, params: dict[str, Any] | None = None
) -> dict[str, Any] | None:
    """One authenticated GET. Returns None for anything but a 200 with JSON.

    Every caller treats None as "this loader has nothing" and falls through to
    the next one, so a vendor outage degrades to IB's own mark rather than
    raising into the session.
    """
    base = settings.massive_rest_url.rstrip("/")
    url = path if path.startswith("http") else f"{base}/{path.lstrip('/')}"
    query = {**(params or {}), "apiKey": settings.massive_api_key}
    try:
        response = await client.get(url, params=query)
    except httpx.HTTPError as exc:
        log.warning("massive.request_failed path=%s error=%s", path, exc)
        return None
    if response.status_code == 429:
        raise RateLimited(path)
    if response.status_code != 200:
        # The key rides in the query string, so log the path only, never the URL.
        log.warning("massive.request_rejected path=%s status=%s", path, response.status_code)
        return None
    try:
        return response.json()
    except ValueError:
        log.warning("massive.bad_json path=%s", path)
        return None


async def _from_indices(client: httpx.AsyncClient, underlying: str) -> Spot | None:
    ticker = index_ticker(underlying)
    if not ticker:
        return None
    body = await get_json(client, "/v3/snapshot/indices", {"ticker.any_of": ticker})
    rows = (body or {}).get("results") or []
    if not rows:
        return None
    row = rows[0]
    price = _price(row.get("value")) or _price((row.get("session") or {}).get("close"))
    return Spot(price, "indices_snapshot") if price else None


async def _from_options(client: httpx.AsyncClient, underlying: str) -> Spot | None:
    """The underlying price Massive stamps on an option chain snapshot."""
    body = await get_json(client, f"/v3/snapshot/options/{underlying.upper()}", {"limit": 50})
    for row in (body or {}).get("results") or []:
        asset = row.get("underlying_asset") or {}
        price = _price(asset.get("price"))
        if price and ticker_matches(underlying, str(asset.get("ticker") or "")):
            return Spot(price, "options_snapshot")
    return None


async def _from_prev_close(client: httpx.AsyncClient, underlying: str) -> Spot | None:
    ticker = index_ticker(underlying) or underlying.upper()
    body = await get_json(client, f"/v2/aggs/ticker/{ticker}/prev", {"adjusted": "true"})
    rows = (body or {}).get("results") or []
    price = _price(rows[0].get("c")) if rows else None
    return Spot(price, "aggs_prev") if price else None


async def _from_stocks(client: httpx.AsyncClient, underlying: str) -> Spot | None:
    body = await get_json(client, f"/v2/snapshot/locale/us/markets/stocks/tickers/{underlying.upper()}")
    ticker = (body or {}).get("ticker") or {}
    day = ticker.get("day") or {}
    price = _price(day.get("c")) or _price((ticker.get("lastTrade") or {}).get("p"))
    return Spot(price, "stocks_snapshot") if price else None


#: Non-index fallbacks, strongest source first. Configured cash-index option
#: underlyings intentionally use only the option-chain snapshot: its documented
#: `underlying_asset.price` supplies the RMS reference in one API request.
NON_INDEX_LOADERS = (_from_options, _from_prev_close, _from_stocks)


async def fetch_spot(client: httpx.AsyncClient, underlying: str) -> Spot | None:
    """Fetch one option-chain snapshot for an index, or a non-index fallback."""
    if index_ticker(underlying):
        return await _from_options(client, underlying)
    for loader in NON_INDEX_LOADERS:
        spot = await loader(client, underlying)
        if spot is not None:
            return spot
    return None
