"""SnapTrade provider: a brokerage link that needs no gateway process.

SnapTrade aggregates brokerage connections (Interactive Brokers among them)
behind one REST API, so a client can be onboarded by clicking through a hosted
consent screen instead of handing over IBKR credentials and waiting for a
gateway to be provisioned. It is a *polling* source — there is no streaming
socket — so the session refreshes on an interval rather than reacting to
callbacks.

Requests are signed the way SnapTrade requires: `clientId` and a millisecond
`timestamp` on the query string, plus a `Signature` header carrying an
HMAC-SHA256 of the canonical request under the partner consumer key.

The provider stays unavailable until `SNAPTRADE_CLIENT_ID` and
`SNAPTRADE_CONSUMER_KEY` are configured — half-configured would mean silent
failures at 3am rather than a clear message at setup time.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from decimal import Decimal
from typing import Any

import httpx
from fastapi import HTTPException

from app.config import settings
from app.domain import AccountState, Execution, Order, Position, now


def configured() -> bool:
    return bool(settings.snaptrade_client_id and settings.snaptrade_consumer_key)


def require_configured() -> None:
    if not configured():
        raise HTTPException(
            503,
            "SnapTrade is not configured on this host. Set SNAPTRADE_CLIENT_ID and "
            "SNAPTRADE_CONSUMER_KEY, then restart the API and worker.",
        )


def sign(path: str, query: dict[str, str], body: Any | None) -> str:
    """SnapTrade's request signature.

    The signed content is a JSON object of the request's content, path, and
    query, serialised with sorted keys and no whitespace, HMAC-SHA256 under the
    consumer key, base64url encoded.
    """
    content = json.dumps(
        {"content": body, "path": path, "query": "&".join(f"{k}={v}" for k, v in sorted(query.items()))},
        separators=(",", ":"),
        sort_keys=True,
    )
    digest = hmac.new(
        settings.snaptrade_consumer_key.encode(), content.encode(), hashlib.sha256
    ).digest()
    return base64.urlsafe_b64encode(digest).decode()


class SnapTradeClient:
    """Thin signed-REST client. One instance per broker connection."""

    def __init__(self, user_id: str | None = None, user_secret: str | None = None, client: Any = None):
        require_configured()
        self.user_id = user_id
        self.user_secret = user_secret
        self._client = client
        self._owned = client is None

    async def __aenter__(self) -> "SnapTradeClient":
        if self._client is None:
            self._client = httpx.AsyncClient(base_url=settings.snaptrade_base_url, timeout=30)
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._owned and self._client is not None:
            await self._client.aclose()

    async def request(
        self,
        method: str,
        path: str,
        *,
        body: Any | None = None,
        authenticated: bool = True,
        params: dict[str, str] | None = None,
    ) -> Any:
        query = {
            "clientId": settings.snaptrade_client_id,
            "timestamp": str(int(time.time())),
            **(params or {}),
        }
        if authenticated:
            if not (self.user_id and self.user_secret):
                raise HTTPException(409, "This SnapTrade connection has not been registered yet")
            query["userId"] = self.user_id
            query["userSecret"] = self.user_secret
        response = await self._client.request(
            method,
            path,
            params=query,
            json=body,
            headers={"Signature": sign(path, query, body), "Accept": "application/json"},
        )
        if response.status_code >= 400:
            detail = response.text[:400]
            raise HTTPException(
                502 if response.status_code >= 500 else 409,
                f"SnapTrade {method} {path} failed ({response.status_code}): {detail}",
            )
        return response.json() if response.content else None

    async def register_user(self, user_id: str) -> dict[str, Any]:
        """Create the SnapTrade user backing one connection.

        Returns the `userSecret`, which is the only credential that can act for
        that user; it is stored encrypted and never returned by this API.
        """
        return await self.request(
            "POST", "/snapTrade/registerUser", body={"userId": user_id}, authenticated=False
        )

    async def login_link(self, redirect_uri: str | None = None) -> str:
        """A one-time hosted-consent URL for the client to link their brokerage."""
        body: dict[str, Any] = {}
        target = redirect_uri or settings.snaptrade_redirect_uri
        if target:
            body["customRedirect"] = target
        payload = await self.request("POST", "/snapTrade/login", body=body)
        link = (payload or {}).get("redirectURI")
        if not link:
            raise HTTPException(502, "SnapTrade did not return a connection link")
        return link

    async def delete_user(self) -> None:
        await self.request("DELETE", "/snapTrade/deleteUser")

    async def authorizations(self) -> list[dict[str, Any]]:
        return await self.request("GET", "/authorizations") or []

    async def accounts(self) -> list[dict[str, Any]]:
        return await self.request("GET", "/accounts") or []

    async def balances(self, account_id: str) -> list[dict[str, Any]]:
        return await self.request("GET", f"/accounts/{account_id}/balances") or []

    async def positions(self, account_id: str) -> list[dict[str, Any]]:
        return await self.request("GET", f"/accounts/{account_id}/positions") or []

    async def orders(self, account_id: str) -> list[dict[str, Any]]:
        return await self.request("GET", f"/accounts/{account_id}/orders") or []

    async def activities(self, account_id: str) -> list[dict[str, Any]]:
        return (
            await self.request(
                "GET", "/activities", params={"accounts": account_id, "type": "BUY,SELL"}
            )
            or []
        )


def _decimal(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        result = Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None
    return result if result.is_finite() else None


def _symbol(row: dict[str, Any]) -> dict[str, Any]:
    """SnapTrade nests the instrument differently per endpoint; normalise it."""
    symbol = row.get("symbol") or {}
    if isinstance(symbol, dict):
        inner = symbol.get("symbol")
        if isinstance(inner, dict):
            symbol = inner
    elif isinstance(symbol, str):
        symbol = {"symbol": symbol}
    return symbol if isinstance(symbol, dict) else {}


def normalize_account(row: dict[str, Any], balances: list[dict[str, Any]]) -> AccountState:
    """Map a SnapTrade account and its balances onto this platform's domain.

    SnapTrade reports far less than IBKR's account summary: margin figures and
    buying power are frequently absent. They stay `None` rather than being
    invented, and the dashboard renders a blank the same way it does for an
    IBKR valuation the broker declined to supply.
    """
    totals = row.get("balance") or {}
    currency = "USD"
    cash = None
    for entry in balances:
        code = (entry.get("currency") or {}).get("code")
        if code:
            currency = code
        cash = _decimal(entry.get("cash")) if cash is None else cash
    total = totals.get("total") or {}
    return AccountState(
        account_id=str(row.get("number") or row.get("id") or ""),
        currency=(total.get("currency") or currency or "USD"),
        net_liquidation=_decimal(total.get("amount")),
        cash=cash,
        updated_at=now(),
    )


def normalize_position(account_id: str, row: dict[str, Any]) -> Position:
    symbol = _symbol(row)
    quantity = _decimal(row.get("units")) or Decimal(0)
    price = _decimal(row.get("price"))
    average = _decimal(row.get("average_purchase_price")) or Decimal(0)
    return Position(
        account_id=account_id,
        # SnapTrade has no IBKR conId; a stable hash of its symbol id keeps the
        # positive-integer identity the rest of the platform indexes on.
        con_id=abs(hash(str(symbol.get("id") or symbol.get("symbol") or ""))) % (2**31),
        symbol=str(symbol.get("symbol") or ""),
        local_symbol=str(symbol.get("description") or ""),
        sec_type=str((symbol.get("type") or {}).get("code") or "STK").upper(),
        currency=str((symbol.get("currency") or {}).get("code") or ""),
        exchange=str((symbol.get("exchange") or {}).get("code") or ""),
        quantity=quantity,
        average_cost=average,
        market_price=price,
        market_value=(price * quantity) if price is not None else None,
        unrealized_pnl=((price - average) * quantity) if price is not None else None,
    )


def normalize_order(account_id: str, row: dict[str, Any], index: int) -> Order:
    symbol = _symbol(row)
    quantity = _decimal(row.get("total_quantity")) or Decimal(0)
    filled = _decimal(row.get("filled_quantity")) or Decimal(0)
    return Order(
        account_id=account_id,
        order_id=index,
        # SnapTrade order ids are opaque strings; the platform's order identity
        # is a positive integer, so a stable hash stands in for the permId.
        perm_id=abs(hash(str(row.get("brokerage_order_id") or index))) % (2**31),
        client_id=0,
        con_id=abs(hash(str(symbol.get("id") or symbol.get("symbol") or ""))) % (2**31),
        symbol=str(symbol.get("symbol") or ""),
        sec_type=str((symbol.get("type") or {}).get("code") or "STK").upper(),
        side=str(row.get("action") or ""),
        order_type=str(row.get("order_type") or ""),
        quantity=quantity,
        limit_price=_decimal(row.get("limit_price")),
        aux_price=_decimal(row.get("stop_price")),
        filled_quantity=filled,
        remaining_quantity=max(Decimal(0), quantity - filled),
        status=str(row.get("status") or "Unknown"),
    )


def normalize_activity(account_id: str, row: dict[str, Any]) -> Execution | None:
    from datetime import datetime

    symbol = _symbol(row)
    quantity = _decimal(row.get("units"))
    price = _decimal(row.get("price"))
    stamp = row.get("trade_date") or row.get("settlement_date")
    if quantity is None or price is None or not stamp:
        return None
    try:
        executed_at = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except ValueError:
        return None
    return Execution(
        execution_id=str(row.get("id") or ""),
        account_id=account_id,
        order_id=0,
        perm_id=0,
        con_id=abs(hash(str(symbol.get("id") or symbol.get("symbol") or ""))) % (2**31),
        symbol=str(symbol.get("symbol") or ""),
        side=str(row.get("type") or ""),
        quantity=abs(quantity),
        price=price,
        exchange="SNAPTRADE",
        commission=_decimal(row.get("fee")),
        executed_at=executed_at,
    )
