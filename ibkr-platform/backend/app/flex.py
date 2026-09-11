"""IBKR Flex Web Service: the only source of account history from before this
platform was watching.

The worker's own snapshots start the day they are switched on. Flex serves the
broker's `EquitySummaryByReportDateInBase` rows — one net-liquidation figure per
report date, in the account's base currency — which is what backfills the equity
curve behind them.

Two calls, in order: `SendRequest` hands back a reference code, `GetStatement`
turns that code into the statement. IBKR generates the statement asynchronously,
so the second call answers `Warn` with code 1019 until it is ready; that is a
retry, not a failure.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from xml.etree import ElementTree

import httpx

from app.config import settings

log = logging.getLogger("app.flex")

BASE = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService"
SEND = f"{BASE}/SendRequest"
GET = f"{BASE}/GetStatement"

#: "Statement generation in progress" — the documented signal to wait and re-ask.
IN_PROGRESS = "1019"


class FlexError(Exception):
    """IBKR refused the request. Carries their own code so it can be reported."""

    def __init__(self, code: str, message: str) -> None:
        self.code, self.message = code, message
        super().__init__(f"{code}: {message}" if code else message)


@dataclass(frozen=True, slots=True)
class NavPoint:
    account_id: str
    #: The broker's report date, YYYY-MM-DD.
    report_date: str
    net_liquidation: Decimal
    currency: str


def _decimal(value: str | None) -> Decimal | None:
    if not value:
        return None
    try:
        return Decimal(value)
    except (InvalidOperation, ValueError):
        return None


def _date(value: str | None) -> str | None:
    """IBKR sends either 20260910 or 2026-09-10 depending on the query's format."""
    if not value:
        return None
    digits = value.replace("-", "")
    if len(digits) != 8 or not digits.isdigit():
        return None
    return f"{digits[:4]}-{digits[4:6]}-{digits[6:]}"


def _raise_for_status(root: ElementTree.Element) -> None:
    status = (root.findtext("Status") or "").strip()
    if status and status != "Success":
        code = (root.findtext("ErrorCode") or "").strip()
        raise FlexError(code, (root.findtext("ErrorMessage") or "").strip() or status)


def parse_statement(xml: str) -> list[NavPoint]:
    """Every daily net-liquidation row in a Flex statement.

    Rows without a usable date or total are dropped rather than guessed at: a
    partial curve is honest, an invented point is not.
    """
    root = ElementTree.fromstring(xml)
    _raise_for_status(root)
    points: list[NavPoint] = []
    for row in root.iter("EquitySummaryByReportDateInBase"):
        account = (row.get("accountId") or "").strip()
        date = _date(row.get("reportDate"))
        total = _decimal(row.get("total"))
        if not account or not date or total is None:
            continue
        points.append(
            NavPoint(
                account_id=account,
                report_date=date,
                net_liquidation=total,
                currency=(row.get("currency") or "BASE").strip() or "BASE",
            )
        )
    return points


async def _send(client: httpx.AsyncClient, token: str, query_id: str) -> str:
    response = await client.get(SEND, params={"t": token, "q": query_id, "v": "3"})
    response.raise_for_status()
    root = ElementTree.fromstring(response.text)
    _raise_for_status(root)
    code = (root.findtext("ReferenceCode") or "").strip()
    if not code:
        raise FlexError("", "Flex returned no reference code")
    return code


async def _collect(client: httpx.AsyncClient, token: str, code: str, attempts: int) -> str:
    for attempt in range(attempts):
        response = await client.get(GET, params={"t": token, "q": code, "v": "3"})
        response.raise_for_status()
        try:
            root = ElementTree.fromstring(response.text)
        except ElementTree.ParseError as exc:
            raise FlexError("", f"Flex returned unparseable XML: {exc}") from exc
        # A ready statement is a FlexQueryResponse; only the wrapper carries Status.
        if root.tag != "FlexStatementResponse":
            return response.text
        error = (root.findtext("ErrorCode") or "").strip()
        if error != IN_PROGRESS:
            _raise_for_status(root)
            return response.text
        log.info("flex.statement_pending attempt=%s", attempt + 1)
        await asyncio.sleep(min(2 ** attempt, 15))
    raise FlexError(IN_PROGRESS, "Flex statement was still generating after every retry")


async def fetch_history(
    token: str | None = None, query_id: str | None = None, *, attempts: int = 6
) -> list[NavPoint]:
    """Run the two-step Flex exchange and return every NAV point it carries."""
    token = (token or settings.ibkr_flex_token).strip()
    query_id = (query_id or settings.ibkr_flex_query_id).strip()
    if not token or not query_id:
        raise FlexError("", "No Flex token or query id configured")
    async with httpx.AsyncClient(timeout=60) as client:
        code = await _send(client, token, query_id)
        return parse_statement(await _collect(client, token, code, attempts))
