"""Days that are not like other days: holidays, half-days, and FOMC meetings.

A desk trading four-day SPX options cares about these for a reason the payoff
model cannot see — a holiday removes a session from the time it thought it had,
a half-day removes half of one, and an FOMC afternoon moves the underlying more
than the previous fortnight combined.

Two sources, because no single free one covers both:

* Exchange holidays come from Finnhub, whose free tier includes them along with
  the shortened hours for a half-day.
* FOMC meeting dates come from the Federal Reserve's own published calendar.
  Finnhub's economic calendar is a paid endpoint, and the Fed is the primary
  source anyway — nobody is more authoritative about when the Fed meets.

CPI and payrolls are deliberately absent: the BLS blocks automated access to its
release schedule, so those dates cannot be fetched from source. They are a fixed
annual list and can be seeded by hand — see `seed_releases`.
"""

from __future__ import annotations

import logging
import re
from datetime import date, datetime
from typing import Any

import httpx

from app.config import settings

log = logging.getLogger("ibkr-worker")

#: The Fed's calendar is a panel per year, each holding a column of month names
#: and a matching column of day ranges. The press-conference links on the same
#: page look tempting and are useless here: they only appear once a meeting has
#: happened, so the newest one is always in the past.
FOMC_PANEL = re.compile(r"(\d{4}) FOMC Meetings(.*?)(?=\d{4} FOMC Meetings|$)", re.S)
FOMC_MONTH = re.compile(r"fomc-meeting__month[^>]*>\s*<strong>([A-Za-z/]+)</strong>")
FOMC_DAYS = re.compile(r"fomc-meeting__date[^>]*>\s*([^<]+?)\s*<")
MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11,
    "december": 12,
}


def configured() -> bool:
    return bool(settings.finnhub_api_key)


async def fetch_holidays(client: httpx.AsyncClient) -> list[dict[str, Any]]:
    """Exchange holidays and half-days, newest source of truth first.

    A half-day is distinguished by carrying trading hours: a full closure has
    none. That difference matters more than the name — the desk can trade a
    half-day, and the payoff it holds expires an hour and a half early.
    """
    if not configured():
        return []
    try:
        response = await client.get(
            f"{settings.finnhub_rest_url}/stock/market-holiday",
            params={"exchange": "US", "token": settings.finnhub_api_key},
            timeout=20,
        )
    except httpx.HTTPError as exc:
        log.warning("events.holidays_failed error=%s", exc)
        return []
    if response.status_code != 200:
        log.warning("events.holidays_rejected status=%s", response.status_code)
        return []
    out = []
    for row in (response.json() or {}).get("data") or []:
        day = str(row.get("atDate") or "")
        if not valid_day(day):
            continue
        hours = str(row.get("tradingHour") or "").strip()
        out.append({
            "date": day,
            "kind": "half_day" if hours else "holiday",
            "name": str(row.get("eventName") or "Market holiday"),
            "hours": hours,
            "source": "finnhub",
        })
    return out


async def fetch_fomc(client: httpx.AsyncClient) -> list[dict[str, Any]]:
    """FOMC decision days from the Fed's own published calendar."""
    try:
        response = await client.get(settings.fomc_calendar_url, timeout=25)
    except httpx.HTTPError as exc:
        log.warning("events.fomc_failed error=%s", exc)
        return []
    if response.status_code != 200:
        log.warning("events.fomc_rejected status=%s", response.status_code)
        return []
    out: list[dict[str, Any]] = []
    for year, body in FOMC_PANEL.findall(response.text):
        months = FOMC_MONTH.findall(body)
        days = [d for d in FOMC_DAYS.findall(body) if d.strip()]
        for month, span in zip(months, days):
            decided = decision_day(int(year), month, span)
            if decided:
                out.append({
                    "date": decided,
                    "kind": "fomc",
                    "name": "FOMC decision",
                    "hours": "",
                    "source": "federalreserve.gov",
                })
    return sorted(out, key=lambda event: event["date"])


def decision_day(year: int, month: str, span: str) -> str | None:
    """The day a meeting's decision lands, which is the last day of its span.

    A meeting runs two days and the statement comes on the second. Some straddle
    a month boundary ("January/February", "31-1"), where the closing day belongs
    to the second month — and, at a year end, to the next year.
    """
    names = [part.strip().lower() for part in month.split("/") if part.strip()]
    numbers = [int(n) for n in re.findall(r"\d+", span)]
    if not names or not numbers:
        return None
    first, last = numbers[0], numbers[-1]
    # A span that counts downwards has crossed into the following month.
    crossed = last < first
    name = names[-1] if crossed and len(names) > 1 else names[0]
    number = MONTHS.get(name)
    if not number:
        return None
    if crossed and len(names) == 1:
        number += 1
    if number > 12:
        number, year = number - 12, year + 1
    try:
        return date(year, number, last).isoformat()
    except ValueError:
        return None


def valid_day(day: str) -> bool:
    try:
        return datetime.strptime(day, "%Y-%m-%d").date().isoformat() == day
    except (ValueError, TypeError):
        return False


def seed_releases(rows: list[tuple[str, str]]) -> list[dict[str, Any]]:
    """Hand-entered release dates, for the schedules that cannot be fetched.

    BLS publishes CPI and payrolls a year ahead and then blocks automated
    access to the page, so these arrive as a list rather than a request. Kept
    separate from the fetched sources so it is obvious which dates are attested
    by a server and which were typed in by a person.
    """
    return [
        {"date": day, "kind": "release", "name": name, "hours": "", "source": "manual"}
        for day, name in rows
        if valid_day(day)
    ]


def upcoming(events: list[dict[str, Any]], today: str, days: int = 14) -> list[dict[str, Any]]:
    """Events from today forward, soonest first."""
    try:
        start = datetime.strptime(today, "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return []
    horizon = date.fromordinal(start.toordinal() + max(0, days))
    found = [
        event for event in events
        if valid_day(event.get("date", ""))
        and start.isoformat() <= event["date"] <= horizon.isoformat()
    ]
    return sorted(found, key=lambda event: (event["date"], event["kind"]))


def describe(event: dict[str, Any]) -> str:
    """One line, in the terms the desk reads it in."""
    kind = event.get("kind")
    name = event.get("name") or "Event"
    if kind == "half_day":
        return f"{name} — half day, {event.get('hours') or 'shortened hours'}"
    if kind == "holiday":
        return f"{name} — market closed"
    if kind == "fomc":
        return "FOMC decision day"
    return str(name)
