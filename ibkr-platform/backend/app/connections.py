from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import uuid4

from fastapi import HTTPException
from pydantic import BaseModel, Field

from app.config import settings
from app.tenancy import now


class Provider(StrEnum):
    IBKR_GATEWAY = "ibkr_gateway"
    SNAPTRADE = "snaptrade"


class ConnectionStatus(StrEnum):
    DRAFT = "DRAFT"
    ENABLED = "ENABLED"
    DISABLED = "DISABLED"

SUPERVISED = (ConnectionStatus.ENABLED.value,)


class BrokerConnection(BaseModel):
    """Serialisable view of one connection. Secrets are never included."""

    id: str
    tenant_id: str
    name: str
    provider: Provider
    status: ConnectionStatus = ConnectionStatus.DRAFT
    managed: bool = True

    host: str = "127.0.0.1"
    api_port: int = 0
    client_id: int = 17
    trading_mode: str = "paper"
    ibkr_username: str | None = None
    account_filter: str = ""
    ibc_config_path: str | None = None
    ibc_log_directory: str | None = None
    service_unit: str | None = None
    launcher_log: str | None = None

    snaptrade_user_id: str | None = None
    snaptrade_authorized: bool = False
    snaptrade_authorization_ids: list[str] = Field(default_factory=list)

    created_at: datetime | None = None
    updated_at: datetime | None = None
    created_by: str | None = None
    last_state: dict[str, Any] | None = None

    @property
    def is_gateway(self) -> bool:
        return self.provider is Provider.IBKR_GATEWAY

REDACTED = ("snaptrade_user_secret", "ibkr_password")


def present(doc: dict[str, Any]) -> dict[str, Any]:
    row = {key: value for key, value in doc.items() if key not in REDACTED}
    row["id"] = row.pop("_id")
    return BrokerConnection.model_validate(row).model_dump(mode="json")


async def by_id(db, tenant_id: str, connection_id: str) -> dict[str, Any]:
    doc = await db.broker_connections.find_one({"_id": connection_id, "tenant_id": tenant_id})
    if not doc:
        raise HTTPException(404, "Broker connection not found")
    return doc


async def list_for(db, tenant_id: str) -> list[dict[str, Any]]:
    cursor = db.broker_connections.find({"tenant_id": tenant_id}).sort("name", 1)
    return [doc async for doc in cursor]


async def supervised(db) -> list[dict[str, Any]]:
    """Every connection the worker should currently hold a session for."""
    active = [t["_id"] async for t in db.tenants.find({"status": "ACTIVE"}, {"_id": 1})]
    if not active:
        return []
    cursor = db.broker_connections.find(
        {"tenant_id": {"$in": active}, "status": {"$in": list(SUPERVISED)}}
    )
    return [doc async for doc in cursor]


async def primary(db, tenant_id: str) -> dict[str, Any] | None:
    """The connection the tenant's single-gateway UI surfaces.

    Prefers an enabled one, so the dashboard's gateway panel keeps pointing at a
    live session rather than a parked draft.
    """
    for status in (ConnectionStatus.ENABLED.value, ConnectionStatus.DISABLED.value, None):
        query: dict[str, Any] = {"tenant_id": tenant_id}
        if status:
            query["status"] = status
        doc = await db.broker_connections.find_one(query, sort=[("created_at", 1)])
        if doc:
            return doc
    return None


async def allocate_port(db, tenant_id: str) -> int:
    """Pick a free API port for a newly provisioned gateway.

    Ports are unique across the whole host, not per tenant: two tenants'
    gateways are two processes on one machine and cannot share a listener.
    """
    taken = {
        doc["api_port"]
        async for doc in db.broker_connections.find({"api_port": {"$gt": 0}}, {"api_port": 1})
    }
    taken.add(settings.ibkr_port)
    for port in range(settings.gateway_port_range_start, settings.gateway_port_range_end + 1):
        if port not in taken:
            return port
    raise HTTPException(
        409,
        f"No free gateway port between {settings.gateway_port_range_start} and "
        f"{settings.gateway_port_range_end}; widen GATEWAY_PORT_RANGE_* or remove a connection",
    )


async def allocate_client_id(db, tenant_id: str) -> int:
    taken = {
        doc.get("client_id", 0)
        async for doc in db.broker_connections.find({"tenant_id": tenant_id}, {"client_id": 1})
    }
    candidate = max(settings.ibkr_client_id, 1)
    while candidate in taken:
        candidate += 1
    return candidate


def new_connection(tenant_id: str, name: str, provider: Provider, **extra: Any) -> dict[str, Any]:
    moment = now()
    return {
        "_id": str(uuid4()),
        "tenant_id": tenant_id,
        "name": name.strip(),
        "provider": provider.value,
        "status": ConnectionStatus.DRAFT.value,
        "managed": True,
        "created_at": moment,
        "updated_at": moment,
        **extra,
    }


def unit_for(doc: dict[str, Any]) -> str:
    unit = doc.get("service_unit")
    if unit:
        return unit
    return settings.gateway_instance_unit.format(instance=doc["_id"])
