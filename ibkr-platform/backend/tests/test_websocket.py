from contextlib import asynccontextmanager

import pytest
from fakeredis.aioredis import FakeRedis
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient
from starlette.websockets import WebSocketDisconnect

from app.auth import COOKIE, TENANT_COOKIE, digest
from app.domain import Event
from app.main import app
from app.state import StateRepository
from app.tenancy import new_tenant

TENANT = "ws-tenant"
OTHER = "ws-other"

@asynccontextmanager
async def ws_lifespan(app):
    redis = FakeRedis(decode_responses=True)
    db = AsyncMongoMockClient().ws
    app.state.redis, app.state.db = redis, db
    for slug in (TENANT, OTHER):
        await db.tenants.insert_one({**new_tenant(slug.title(), slug), "_id": slug})
    await db.users.insert_one({"_id": "trader", "email": "trader@test.local"})
    await db.tenant_members.insert_one(
        {
            "_id": "m1",
            "tenant_id": TENANT,
            "user_id": "trader",
            "role": "TRADER",
            "accounts": ["DU1"],
            "status": "ACTIVE",
        }
    )
    await redis.set(f"session:{digest('token')}", "trader")
    await StateRepository(redis, OTHER, "c2").publish(
        Event(event_type="position.updated", account_id="DU1", data={"con_id": 7, "quantity": "3"})
    )
    yield
    await redis.aclose()

def connect(client):
    return client.websocket_connect("/ws/live", headers={"Origin": "http://localhost:3000"})

def test_websocket_subscribe_ping_and_forbidden_account(monkeypatch):
    monkeypatch.setattr(app.router, "lifespan_context", ws_lifespan)
    with TestClient(app) as client:
        client.cookies.set(COOKIE, "token")
        client.cookies.set(TENANT_COOKIE, TENANT)
        with connect(client) as ws:
            ws.send_json({"type": "subscribe", "accounts": ["DU1"]})
            assert ws.receive_json()["event_type"] == "subscribed"
            ws.send_json({"type": "ping"})
            assert ws.receive_json()["event_type"] == "pong"
            ws.send_json({"type": "subscribe", "accounts": ["*"]})
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()

def test_websocket_rejects_origin_and_missing_session(monkeypatch):
    monkeypatch.setattr(app.router, "lifespan_context", ws_lifespan)
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws/live", headers={"Origin": "https://evil.test"}):
                pass
        with pytest.raises(WebSocketDisconnect):
            with connect(client):
                pass

def test_websocket_refuses_a_tenant_without_membership(monkeypatch):
    monkeypatch.setattr(app.router, "lifespan_context", ws_lifespan)
    with TestClient(app) as client:
        client.cookies.set(COOKIE, "token")
        client.cookies.set(TENANT_COOKIE, OTHER)
        with pytest.raises(WebSocketDisconnect):
            with connect(client):
                pass

def test_websocket_reads_only_its_own_tenant_stream(monkeypatch):
    monkeypatch.setattr(app.router, "lifespan_context", ws_lifespan)
    with TestClient(app) as client:
        client.cookies.set(COOKIE, "token")
        client.cookies.set(TENANT_COOKIE, TENANT)
        with connect(client) as ws:
            ws.send_json({"type": "subscribe", "accounts": ["DU1"]})
            assert ws.receive_json()["event_type"] == "subscribed"
            repo = StateRepository(app.state.redis, TENANT, "c1")
            portal = client.portal
            portal.call(
                repo.publish,
                Event(event_type="position.updated", account_id="DU1", data={"con_id": 42, "quantity": "1"}),
            )
            event = ws.receive_json()
            assert event["event_type"] == "position.updated"
            assert event["data"]["con_id"] == 42
