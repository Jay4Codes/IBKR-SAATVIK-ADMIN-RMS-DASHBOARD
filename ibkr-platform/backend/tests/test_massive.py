import asyncio
import csv
import json
import logging
from datetime import UTC, datetime
from decimal import Decimal
from unittest.mock import MagicMock, patch

import httpx
import pytest

from app import massive
from app.domain import Event
from app.worker import GatewaySession
from tests.conftest import CONNECTION, TENANT, gateway_connection


def bodies(**by_path):
    """Stand in for `massive.get_json`, answering by path prefix."""

    async def fake(client, path, params=None):
        for prefix, body in by_path.items():
            if path.startswith(prefix):
                return body
        return None

    return fake


def test_index_tickers_are_prefixed_and_stocks_are_not():
    assert massive.index_ticker("spx") == "I:SPX"
    assert massive.index_ticker("SPY") is None
    assert massive.ticker_matches("SPX", "I:SPX")
    assert massive.ticker_matches("SPX", "SPX")
    assert massive.ticker_matches("SPX", "")
    assert not massive.ticker_matches("SPY", "I:SPX")


async def test_an_index_snapshot_can_resolve_spx():
    body = {"results": [{"value": 7612.5, "session": {"close": 7000}}]}
    with patch.object(massive, "get_json", bodies(**{"/v3/snapshot/indices": body})):
        spot = await massive._from_indices(MagicMock(), "SPX")
    assert spot == massive.Spot(Decimal("7612.5"), "indices_snapshot")


async def test_a_dark_index_falls_back_to_the_session_close():
    body = {"results": [{"value": None, "session": {"close": 7500.25}}]}
    with patch.object(massive, "get_json", bodies(**{"/v3/snapshot/indices": body})):
        spot = await massive._from_indices(MagicMock(), "SPX")
    assert spot == massive.Spot(Decimal("7500.25"), "indices_snapshot")


async def test_a_stock_skips_the_index_loader_and_takes_the_chain_snapshot():
    chain = {"results": [{"underlying_asset": {"ticker": "SPY", "price": 612.4}}]}
    with patch.object(massive, "get_json", bodies(**{"/v3/snapshot/options/": chain})):
        spot = await massive.fetch_spot(MagicMock(), "SPY")
    assert spot == massive.Spot(Decimal("612.4"), "options_snapshot")


async def test_spx_takes_its_underlying_price_from_the_option_chain_snapshot():
    chain = {"results": [{"underlying_asset": {"ticker": "I:SPX", "price": 7612.5}}]}
    with patch.object(massive, "get_json", bodies(**{"/v3/snapshot/options/SPX": chain})):
        spot = await massive.fetch_spot(MagicMock(), "SPX")
    assert spot == massive.Spot(Decimal("7612.5"), "options_snapshot")


async def test_a_chain_row_for_a_different_underlying_is_not_borrowed():
    chain = {"results": [{"underlying_asset": {"ticker": "QQQ", "price": 500}}]}
    prev = {"results": [{"c": 611.1}]}
    with patch.object(
        massive,
        "get_json",
        bodies(**{"/v3/snapshot/options/": chain, "/v2/aggs/": prev}),
    ):
        spot = await massive.fetch_spot(MagicMock(), "SPY")
    assert spot == massive.Spot(Decimal("611.1"), "aggs_prev")


async def test_every_loader_silent_yields_no_spot():
    with patch.object(massive, "get_json", bodies()):
        assert await massive.fetch_spot(MagicMock(), "SPX") is None


async def test_spx_spends_only_one_option_request_per_poll_cycle():
    calls = []

    async def empty(client, path, params=None):
        calls.append(path)
        return None

    with patch.object(massive, "get_json", empty):
        assert await massive.fetch_spot(MagicMock(), "SPX") is None
    assert calls == ["/v3/snapshot/options/SPX"]


@pytest.mark.parametrize("value", [None, 0, -1, "", "n/a"])
async def test_an_unusable_price_is_not_treated_as_a_quote(value):
    body = {"results": [{"value": value, "session": {}}]}
    with patch.object(massive, "get_json", bodies(**{"/v3/snapshot/indices": body})):
        assert await massive.fetch_spot(MagicMock(), "SPX") is None


async def test_a_rejected_request_returns_none_rather_than_raising():
    async def refuse(url, params=None):
        return httpx.Response(403, text="forbidden", request=httpx.Request("GET", url))

    client = MagicMock()
    client.get = refuse
    with patch.object(massive.settings, "massive_api_key", "k"):
        assert await massive.get_json(client, "/v3/snapshot/indices") is None


async def test_a_transport_failure_returns_none_rather_than_raising():
    async def explode(url, params=None):
        raise httpx.ConnectError("no route to host")

    client = MagicMock()
    client.get = explode
    assert await massive.get_json(client, "/v3/snapshot/indices") is None


def worker(redis, db, ib=None):
    connection = gateway_connection(TENANT, CONNECTION, "Gateway", 4101)
    return GatewaySession(redis, db, TENANT, connection, ib or MagicMock())


async def poll_once(session):
    """Run `spot` far enough to complete one cycle, then stop it."""
    with patch.object(massive, "session_is_open", return_value=True):
        task = asyncio.create_task(session.spot())
        for _ in range(200):
            await asyncio.sleep(0)
            if session.massive_prices:
                break
        session.stop.set()
        await asyncio.wait_for(task, 1)


async def test_a_polled_spot_becomes_the_positions_underlying_price(stores):
    redis, db = stores
    session = worker(redis, db)
    with (
        patch.object(massive.settings, "massive_api_key", "k"),
        patch.object(massive.settings, "massive_underlyings", "SPX"),
        patch.object(massive, "fetch_spot", return_value=massive.Spot(Decimal("7612.5"), "t")),
    ):
        await poll_once(session)
        assert session.massive_prices == {"USD:SPX": massive.Spot(Decimal("7612.5"), "t")}
        assert session.underlying_changed == {"USD:SPX"}
        option = MagicMock(sec_type="OPT", currency="USD", symbol="SPX")
        assert session.underlying_of(option) == Decimal("7612.5")
        assert session.underlying_source_of(option) == "t"


async def test_configured_spx_is_only_served_from_the_common_redis_cache(stores):
    redis, db = stores
    session = worker(redis, db)
    option = MagicMock(sec_type="OPT", currency="USD", symbol="SPX")
    with patch.object(massive.settings, "massive_underlyings", "SPX"):
        session.underlying_prices["USD:SPX"] = Decimal("7000")
        session.massive_prices["USD:SPX"] = massive.Spot(Decimal("7100"), "indices_snapshot")
        assert session.underlying_of(option) is None
        assert session.underlying_source_of(option) == ""

        session.cached_prices["USD:SPX"] = massive.Spot(
            Decimal("7612.5"), "options_snapshot"
        )
        assert session.underlying_of(option) == Decimal("7612.5")
        assert session.underlying_source_of(option) == "options_snapshot_cached"


async def test_a_massive_configured_underlying_still_opens_one_ib_fallback_line(stores):
    redis, db = stores
    ib = MagicMock()
    session = worker(redis, db, ib)
    option = MagicMock(
        sec_type="OPT", currency="USD", symbol="SPX", con_id=1, quantity=Decimal("1")
    )
    with patch.object(massive.settings, "massive_underlyings", "SPX"):
        session.track_underlying(option, MagicMock())
    assert session.market_wanted == {"USD:SPX": 1}
    assert 1 in session.contracts


async def test_a_429_aborts_the_loader_chain_instead_of_spending_the_quota():
    calls = []

    async def limited(client, path, params=None):
        calls.append(path)
        raise massive.RateLimited(path)

    with patch.object(massive, "get_json", limited), pytest.raises(massive.RateLimited):
        await massive.fetch_spot(MagicMock(), "SPX")
    assert len(calls) == 1


async def test_a_rate_limited_cycle_backs_off_without_crying_no_prices(stores):
    redis, db = stores
    session = worker(redis, db)
    with (
        patch.object(massive.settings, "massive_api_key", "k"),
        patch.object(massive.settings, "massive_underlyings", "SPY"),
        patch.object(massive.settings, "massive_idle_seconds", 0.01),
        patch.object(massive, "session_is_open", return_value=True),
        patch.object(massive, "fetch_spot", side_effect=massive.RateLimited("/v2/aggs")),
    ):
        task = asyncio.create_task(session.spot())
        await asyncio.sleep(0.05)
        session.stop.set()
        await asyncio.wait_for(task, 1)
    assert session.massive_prices == {}


async def test_session_samples_archive_to_csv_then_flush_only_their_key(stores, tmp_path):
    redis, _ = stores
    during = datetime(2026, 9, 10, 15, 0, tzinfo=UTC)
    after = datetime(2026, 9, 10, 21, 0, tzinfo=UTC)
    await massive.record_sample(
        redis, "SPX", massive.Spot(Decimal("7601.25"), "indices_snapshot"), at=during
    )
    key = massive.sample_key("SPX", massive.session_day(during))
    await redis.set("unrelated:key", "keep")

    assert await massive.archive_due_samples(redis, "SPX", at=during, directory=str(tmp_path)) == []
    archived = await massive.archive_due_samples(redis, "SPX", at=after, directory=str(tmp_path))

    assert archived == [tmp_path / "SPX" / "SPX_2026-09-10.csv"]
    assert not await redis.exists(key)
    assert await massive.last_spot(redis, "SPX") == massive.Spot(
        Decimal("7601.25"), "indices_snapshot"
    )
    assert await redis.get("unrelated:key") == "keep"
    with archived[0].open(newline="", encoding="utf-8") as source:
        rows = list(csv.DictReader(source))
    assert rows == [
        {
            "timestamp_utc": during.isoformat(),
            "symbol": "SPX",
            "price": "7601.25",
            "source": "indices_snapshot",
        }
    ]


async def test_ib_underlying_sample_is_stored_in_the_session_series(stores):
    redis, db = stores
    session = worker(redis, db)
    session.queue.put_nowait(
        Event(
            event_type="underlying.sampled",
            account_id="*",
            data={
                "currency": "USD",
                "symbol": "SPX",
                "price": "7602.50",
                "source": "ib_und_price",
            },
        )
    )
    processor = asyncio.create_task(session.process())
    await asyncio.wait_for(session.queue.join(), 1)
    processor.cancel()
    await asyncio.gather(processor, return_exceptions=True)

    keys = [key async for key in redis.scan_iter(match="market:underlying:SPX:*:samples")]
    assert len(keys) == 1
    row = json.loads((await redis.lrange(keys[0], 0, -1))[0])
    assert row["price"] == "7602.50"
    assert row["source"] == "ib_und_price"
    assert await massive.last_spot(redis, "SPX") == massive.Spot(
        Decimal("7602.50"), "ib_und_price"
    )
    option = MagicMock(sec_type="OPT", currency="USD", symbol="SPX")
    with patch.object(massive.settings, "massive_underlyings", "SPX"):
        assert session.underlying_of(option) == Decimal("7602.50")
        assert session.underlying_source_of(option) == "ib_und_price"


async def test_ib_tick_is_not_served_until_redis_round_trip_finishes(stores):
    redis, db = stores
    session = worker(redis, db)
    option = MagicMock(sec_type="OPT", currency="USD", symbol="SPX")
    ticker = MagicMock()
    ticker.modelGreeks.undPrice = 7603.25
    ticker.contract.currency = "USD"
    ticker.contract.symbol = "SPX"

    with patch.object(massive.settings, "massive_underlyings", "SPX"):
        session.ticker_value([ticker])
        assert session.underlying_of(option) is None

        processor = asyncio.create_task(session.process())
        await asyncio.wait_for(session.queue.join(), 1)
        processor.cancel()
        await asyncio.gather(processor, return_exceptions=True)

        assert session.underlying_of(option) == Decimal("7603.25")
        assert session.underlying_source_of(option) == "ib_und_price"


async def test_direct_ib_index_ltp_is_stored_before_it_is_served(stores):
    redis, db = stores
    session = worker(redis, db)
    option = MagicMock(sec_type="OPT", currency="USD", symbol="SPX")
    ticker = MagicMock()
    ticker.contract.secType = "IND"
    ticker.contract.currency = "USD"
    ticker.contract.symbol = "SPX"
    ticker.marketPrice.return_value = 7673.13

    with patch.object(massive.settings, "massive_underlyings", "SPX"):
        session.ticker_value([ticker])
        assert session.underlying_of(option) is None

        processor = asyncio.create_task(session.process())
        await asyncio.wait_for(session.queue.join(), 1)
        processor.cancel()
        await asyncio.gather(processor, return_exceptions=True)

        assert await massive.last_spot(redis, "SPX") == massive.Spot(
            Decimal("7673.13"), "ib_index_ltp"
        )
        assert session.underlying_of(option) == Decimal("7673.13")
        assert session.underlying_source_of(option) == "ib_index_ltp"


async def test_massive_has_priority_and_ibkr_takes_over_when_it_is_unavailable(stores):
    redis, db = stores
    session = worker(redis, db)
    ticker = MagicMock()
    ticker.modelGreeks.undPrice = 7603.25
    ticker.contract.currency = "USD"
    ticker.contract.symbol = "SPX"
    session.massive_prices["USD:SPX"] = massive.Spot(
        Decimal("7604.00"), "options_snapshot"
    )

    with patch.object(massive.settings, "massive_underlyings", "SPX"):
        session.ticker_value([ticker])
        assert session.queue.empty()

        session.massive_prices.clear()
        ticker.modelGreeks.undPrice = 7603.50
        session.ticker_value([ticker])
        assert session.queue.qsize() == 1

        processor = asyncio.create_task(session.process())
        await asyncio.wait_for(session.queue.join(), 1)
        processor.cancel()
        await asyncio.gather(processor, return_exceptions=True)

    assert await massive.last_spot(redis, "SPX") == massive.Spot(
        Decimal("7603.50"), "ib_und_price"
    )


async def test_worker_hydrates_stored_spx_ltp_as_a_labeled_fallback(stores):
    redis, db = stores
    await massive.record_sample(
        redis, "SPX", massive.Spot(Decimal("7602.50"), "ib_und_price")
    )
    session = worker(redis, db)
    with patch.object(massive.settings, "massive_underlyings", "SPX"):
        await session.load_cached_underlyings()
    option = MagicMock(sec_type="OPT", currency="USD", symbol="SPX")
    assert session.underlying_of(option) == Decimal("7602.50")
    assert session.underlying_source_of(option) == "ib_und_price_cached"


def test_spx_polling_is_limited_to_the_regular_session():
    assert not massive.session_is_open(datetime(2026, 9, 10, 13, 29, tzinfo=UTC))
    assert massive.session_is_open(datetime(2026, 9, 10, 13, 30, tzinfo=UTC))
    assert not massive.session_is_open(datetime(2026, 9, 10, 20, 0, tzinfo=UTC))


async def test_an_unconfigured_feed_waits_instead_of_ending_the_session(stores):
    """`run` waits on the first task to finish, so `spot` must not return early."""
    redis, db = stores
    session = worker(redis, db)
    task = asyncio.create_task(session.spot())
    await asyncio.sleep(0)
    assert not task.done()
    session.stop.set()
    await asyncio.wait_for(task, 1)


def test_httpx_request_logging_cannot_leak_the_vendor_key(caplog):
    """The key rides in the query string; httpx logs whole URLs at INFO."""
    from app.logging import configure

    configure()
    assert logging.getLogger("httpx").getEffectiveLevel() >= logging.WARNING
