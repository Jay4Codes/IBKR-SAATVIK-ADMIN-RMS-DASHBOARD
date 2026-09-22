from datetime import UTC, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field


def now() -> datetime:
    return datetime.now(UTC)

class GatewayStatus(StrEnum):
    DISCONNECTED = "DISCONNECTED"
    CONNECTING = "CONNECTING"
    CONNECTED = "CONNECTED"
    DEGRADED = "DEGRADED"
    RECONNECTING = "RECONNECTING"
    FAILED = "FAILED"

class GatewayState(BaseModel):
    gateway_id: str = "primary"
    account_id: str = "*"
    host: str = ""
    port: int = 4002
    client_id: int = 17
    status: GatewayStatus = GatewayStatus.DISCONNECTED
    connected_at: datetime | None = None
    disconnected_at: datetime | None = None
    last_heartbeat: datetime | None = None
    last_order_snapshot: datetime | None = None
    reconnect_attempts: int = 0
    last_error: str | None = None
    subscriptions: dict[str, str] = Field(default_factory=dict)

class AccountState(BaseModel):
    account_id: str
    currency: str = "BASE"
    net_liquidation: Decimal | None = None
    cash: Decimal | None = None
    buying_power: Decimal | None = None
    available_funds: Decimal | None = None
    excess_liquidity: Decimal | None = None
    initial_margin: Decimal | None = None
    maintenance_margin: Decimal | None = None
    gross_position_value: Decimal | None = None
    realized_pnl: Decimal | None = None
    unrealized_pnl: Decimal | None = None
    day_pnl: Decimal | None = None

    cushion: Decimal | None = None

    day_trades_remaining: Decimal | None = None
    updated_at: datetime = Field(default_factory=now)

class Position(BaseModel):
    quantity_changed: bool = False
    account_id: str
    con_id: int
    symbol: str
    local_symbol: str = ""
    sec_type: str
    currency: str = ""
    exchange: str = ""
    expiry: str = ""
    strike: Decimal | None = None
    right: str = ""
    multiplier: Decimal | None = None
    quantity: Decimal
    average_cost: Decimal
    market_price: Decimal | None = None
    market_value: Decimal | None = None
    underlying_price: Decimal | None = None
    underlying_source: str = ""
    underlying_prev_close: Decimal | None = None
    unrealized_pnl: Decimal | None = None
    realized_pnl: Decimal | None = None
    updated_at: datetime = Field(default_factory=now)

class Order(BaseModel):
    account_id: str
    order_id: int
    perm_id: int
    client_id: int
    con_id: int
    symbol: str
    sec_type: str
    side: str
    order_type: str
    quantity: Decimal
    limit_price: Decimal | None = None
    aux_price: Decimal | None = None
    filled_quantity: Decimal
    remaining_quantity: Decimal
    status: str
    created_at: datetime = Field(default_factory=now)
    updated_at: datetime = Field(default_factory=now)

    @property
    def key(self) -> str:
        return order_key(self.model_dump())

class Execution(BaseModel):
    execution_id: str
    account_id: str
    order_id: int
    perm_id: int
    con_id: int
    symbol: str
    underlying: str | None = None
    currency: str | None = None
    sec_type: str | None = None
    expiry: str | None = None
    multiplier: str | None = None
    side: str
    quantity: Decimal
    price: Decimal
    exchange: str
    commission: Decimal | None = None
    realized_pnl: Decimal | None = None
    executed_at: datetime

class Event(BaseModel):
    event_id: str = Field(default_factory=lambda: str(uuid4()))
    event_type: str
    account_id: str
    timestamp: datetime = Field(default_factory=now)
    data: dict[str, Any]

def order_key(data: dict) -> str:
    if data.get("perm_id", 0) > 0:
        return f"{data['account_id']}:perm:{data['perm_id']}"
    return f"{data['account_id']}:{data['client_id']}:{data['order_id']}"
