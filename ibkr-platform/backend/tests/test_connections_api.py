"""Registering, provisioning, and retiring a tenant's broker connections."""

import pytest

from app import connections as registry
from app import provisioning, secrets, snaptrade
from app.auth import COOKIE
from app.config import settings
from tests.conftest import CONNECTION, OTHER_TENANT, TENANT


def as_user(role):
    return {COOKIE: role}


@pytest.fixture
def provisioned(monkeypatch, tmp_path):
    """Capture provisioning instead of writing to the host."""
    calls = []

    def fake_provision(doc, password=None):
        calls.append(doc)
        return {
            "ibc_config_path": str(tmp_path / doc["_id"] / "config.ini"),
            "ibc_log_directory": str(tmp_path / "logs" / doc["_id"]),
            "launcher_path": str(tmp_path / doc["_id"] / "gatewaystart.sh"),
            "settings_path": str(tmp_path / doc["_id"] / "settings"),
            "service_unit": f"ibkr-gateway@{doc['_id']}.service",
        }

    async def fake_reload():
        return None

    monkeypatch.setattr(provisioning, "provision_files", fake_provision)
    monkeypatch.setattr(provisioning, "write_unit_template", lambda: "/etc/systemd/system/x.service")
    monkeypatch.setattr("app.main.hostctl.daemon_reload", fake_reload)
    return calls


async def test_listing_connections_requires_a_tenant_admin(client):
    assert (await client.get("/api/v1/connections", cookies=as_user("TRADER"))).status_code == 403
    rows = (await client.get("/api/v1/connections", cookies=as_user("ADMIN"))).json()["data"]
    assert [row["id"] for row in rows] == [CONNECTION]
    assert rows[0]["state"]["status"] == "DISCONNECTED"


async def test_adding_an_ibkr_gateway_provisions_an_isolated_instance(client, stores, provisioned):
    _, db = stores
    response = await client.post(
        "/api/v1/connections", json={"name": "Client gateway", "trading_mode": "paper"}
    )
    assert response.status_code == 200
    created = response.json()["data"]
    assert created["provider"] == "ibkr_gateway"
    assert created["status"] == "DRAFT"
    assert created["managed"] is True
    # A free port and a nonzero client id are chosen without the operator asking.
    assert settings.gateway_port_range_start <= created["api_port"] <= settings.gateway_port_range_end
    assert created["api_port"] != 4101, "must not collide with the tenant's existing gateway"
    assert created["client_id"] > 0
    assert created["service_unit"].endswith(f"{created['id']}.service")
    assert len(provisioned) == 1

    stored = await db.broker_connections.find_one({"_id": created["id"]})
    assert stored["tenant_id"] == TENANT


async def test_ports_are_unique_across_tenants(client, stores, provisioned):
    """Two tenants' gateways are two processes on one host; they cannot share a port."""
    ports = set()
    for name in ("One", "Two", "Three"):
        response = await client.post("/api/v1/connections", json={"name": name})
        assert response.status_code == 200
        ports.add(response.json()["data"]["api_port"])
    assert len(ports) == 3
    assert 4101 not in ports and 4102 not in ports


async def test_a_duplicate_connection_name_is_refused(client, provisioned):
    assert (await client.post("/api/v1/connections", json={"name": "Solo"})).status_code == 200
    assert (await client.post("/api/v1/connections", json={"name": "Solo"})).status_code == 409


async def test_a_connection_cannot_be_enabled_without_a_port(client, stores, provisioned):
    _, db = stores
    created = (await client.post("/api/v1/connections", json={"name": "Portless"})).json()["data"]
    await db.broker_connections.update_one({"_id": created["id"]}, {"$set": {"api_port": 0}})
    response = await client.post(
        f"/api/v1/connections/{created['id']}", json={"status": "ENABLED"}
    )
    assert response.status_code == 409
    assert "no API port" in response.json()["error"]


async def test_changing_the_login_shape_rewrites_the_instance_config(client, stores, provisioned):
    created = (await client.post("/api/v1/connections", json={"name": "Rewritable"})).json()["data"]
    provisioned.clear()
    assert (
        await client.post(f"/api/v1/connections/{created['id']}", json={"name": "Renamed"})
    ).status_code == 200
    assert provisioned == [], "a rename does not touch the gateway's config"

    assert (
        await client.post(f"/api/v1/connections/{created['id']}", json={"read_only_login": False})
    ).status_code == 200
    assert len(provisioned) == 1, "turning off read-only login must reach the config file"


async def test_an_adopted_connection_is_never_rewritten(client, stores, provisioned):
    """The pre-tenancy gateway's files predate us; provisioning must leave them alone."""
    response = await client.post(f"/api/v1/connections/{CONNECTION}", json={"trading_mode": "live"})
    assert response.status_code == 200
    assert provisioned == []


async def test_deleting_a_connection_clears_its_live_state(client, stores, provisioned, monkeypatch):
    redis, db = stores
    stopped = []

    async def fake_stop(action, unit):
        stopped.append((action, unit))
        return "inactive"

    monkeypatch.setattr("app.main.hostctl.process_action", fake_stop)
    removed = []
    monkeypatch.setattr(provisioning, "remove_files", removed.append)

    created = (await client.post("/api/v1/connections", json={"name": "Disposable"})).json()["data"]
    response = await client.delete(f"/api/v1/connections/{created['id']}")
    assert response.status_code == 200
    assert stopped and stopped[0][0] == "stop"
    assert removed and removed[0]["_id"] == created["id"]
    assert await db.broker_connections.find_one({"_id": created["id"]}) is None

    from app.tenancy import TenantKeys

    assert not await redis.exists(TenantKeys(TENANT).gateway(created["id"]))


async def test_a_connection_from_another_tenant_is_invisible(client, stores):
    from tests.conftest import OTHER_CONNECTION

    assert (await client.get(f"/api/v1/connections/{OTHER_CONNECTION}/snaptrade/status")).status_code in (
        404,
        409,
    )
    rows = (await client.get("/api/v1/connections")).json()["data"]
    assert OTHER_CONNECTION not in {row["id"] for row in rows}
    response = await client.post(
        f"/api/v1/connections/{OTHER_CONNECTION}", json={"status": "DISABLED"}
    )
    assert response.status_code == 404


async def test_snaptrade_is_refused_until_it_is_configured(client, monkeypatch):
    monkeypatch.setattr(settings, "snaptrade_client_id", "")
    monkeypatch.setattr(settings, "snaptrade_consumer_key", "")
    response = await client.post(
        "/api/v1/connections", json={"name": "Via SnapTrade", "provider": "snaptrade"}
    )
    assert response.status_code == 503
    assert "SNAPTRADE_CLIENT_ID" in response.json()["error"]


async def test_a_snaptrade_connection_registers_a_user_and_seals_its_secret(
    client, stores, monkeypatch
):
    _, db = stores
    monkeypatch.setattr(settings, "snaptrade_client_id", "test-client")
    monkeypatch.setattr(settings, "snaptrade_consumer_key", "test-key")

    registered = {}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

        async def register_user(self, user_id):
            registered["user_id"] = user_id
            return {"userId": user_id, "userSecret": "top-secret-user-key"}

    monkeypatch.setattr(snaptrade, "SnapTradeClient", FakeClient)
    response = await client.post(
        "/api/v1/connections", json={"name": "Via SnapTrade", "provider": "snaptrade"}
    )
    assert response.status_code == 200
    created = response.json()["data"]
    assert created["provider"] == "snaptrade"
    assert registered["user_id"].startswith(TENANT)
    # The user secret is never echoed and never stored in the clear.
    assert "top-secret-user-key" not in response.text
    stored = await db.broker_connections.find_one({"_id": created["id"]})
    assert stored["snaptrade_user_secret"].startswith("v1:")
    assert secrets.decrypt(stored["snaptrade_user_secret"]) == "top-secret-user-key"


async def test_ibkr_credentials_are_refused_on_a_snaptrade_connection(client, stores):
    _, db = stores
    await db.broker_connections.insert_one(
        {
            "_id": "st-1",
            "tenant_id": TENANT,
            "name": "SnapTrade link",
            "provider": "snaptrade",
            "status": "DRAFT",
            "managed": True,
        }
    )
    response = await client.post(
        "/api/v1/connections/st-1/credentials",
        json={"username": "apibot", "password": "hunter2hunter2", "mode": "live", "port": 4001},
    )
    assert response.status_code == 409
    assert "Only IB Gateway" in response.json()["error"]


async def test_allocate_port_reports_an_exhausted_range(stores, monkeypatch):
    from fastapi import HTTPException

    _, db = stores
    monkeypatch.setattr(settings, "gateway_port_range_start", 4300)
    monkeypatch.setattr(settings, "gateway_port_range_end", 4300)
    await db.broker_connections.insert_one(
        {"_id": "x", "tenant_id": TENANT, "name": "x", "api_port": 4300}
    )
    with pytest.raises(HTTPException) as error:
        await registry.allocate_port(db, TENANT)
    assert error.value.status_code == 409
    assert "GATEWAY_PORT_RANGE" in error.value.detail


async def test_supervised_skips_suspended_tenants(stores):
    _, db = stores
    await db.tenants.insert_one({"_id": TENANT, "slug": "t1", "name": "T1", "status": "ACTIVE"})
    await db.tenants.insert_one(
        {"_id": OTHER_TENANT, "slug": "t2", "name": "T2", "status": "SUSPENDED"}
    )
    await db.broker_connections.insert_one(
        {"_id": "a", "tenant_id": TENANT, "name": "a", "status": "ENABLED", "provider": "ibkr_gateway"}
    )
    await db.broker_connections.insert_one(
        {"_id": "b", "tenant_id": OTHER_TENANT, "name": "b", "status": "ENABLED", "provider": "ibkr_gateway"}
    )
    await db.broker_connections.insert_one(
        {"_id": "c", "tenant_id": TENANT, "name": "c", "status": "DISABLED", "provider": "ibkr_gateway"}
    )
    assert {doc["_id"] for doc in await registry.supervised(db)} == {"a"}
