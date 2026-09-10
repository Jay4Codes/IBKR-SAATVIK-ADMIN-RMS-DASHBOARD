import os
import stat

import pytest

from app import hostctl
from app.auth import COOKIE
from tests.conftest import CONNECTION, TENANT

SECRET = "do-not-leak-this"
TEMPLATE = "IbLoginId=olduser\nIbPassword=oldsecret\nTradingMode=paper\nOverrideTwsApiPort=4002\n"


def as_user(role):
    return {COOKIE: role}


@pytest.fixture
async def config(tmp_path, stores):
    """Point the tenant's connection at a throwaway IBC config."""
    _, db = stores
    path = tmp_path / "config.ini"
    path.write_text(TEMPLATE)
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    await db.broker_connections.update_one(
        {"_id": CONNECTION, "tenant_id": TENANT},
        {"$set": {"ibc_config_path": str(path), "ibc_log_directory": str(tmp_path)}},
    )
    return path


async def test_credentials_require_admin(client, config):
    response = await client.post(
        "/api/v1/gateway/credentials",
        json={"username": "apibot", "password": SECRET, "mode": "live", "port": 4001},
        cookies=as_user("TRADER"),
    )
    assert response.status_code == 403
    assert SECRET not in config.read_text()


async def test_credentials_require_session(client, config):
    client.cookies.clear()
    response = await client.post(
        "/api/v1/gateway/credentials",
        json={"username": "apibot", "password": SECRET, "mode": "live", "port": 4001},
    )
    assert response.status_code == 401


async def test_credentials_written_and_never_echoed(client, config, stores):
    _, db = stores
    response = await client.post(
        "/api/v1/gateway/credentials",
        json={"username": "apibot", "password": SECRET, "mode": "live", "port": 4001},
        cookies=as_user("ADMIN"),
    )
    assert response.status_code == 200
    assert SECRET not in response.text
    assert response.json()["data"] == {"username": "apibot", "mode": "live", "port": 4001}
    assert f"IbPassword={SECRET}" in config.read_text()
    record = await db.audit_logs.find_one({"action": "gateway_credentials"})
    assert record["user_id"] == "ADMIN"
    assert record["tenant_id"] == TENANT
    assert SECRET not in str(record)
    # The password is not mirrored into the connection document either.
    stored = await db.broker_connections.find_one({"_id": CONNECTION})
    assert SECRET not in str(stored)
    assert stored["ibkr_username"] == "apibot"


async def test_credentials_reject_bad_input(client, config):
    for payload in (
        {"username": "api bot", "password": SECRET, "mode": "live", "port": 4001},
        {"username": "apibot", "password": SECRET, "mode": "demo", "port": 4001},
        {"username": "apibot", "password": SECRET, "mode": "live", "port": 0},
        {"username": "apibot", "password": "", "mode": "live", "port": 4001},
    ):
        response = await client.post(
            "/api/v1/gateway/credentials", json=payload, cookies=as_user("ADMIN")
        )
        assert response.status_code == 422, payload
    assert SECRET not in config.read_text()


async def test_gateway_never_exposes_password(client, config, monkeypatch):
    async def fake_state(unit):
        return "active"

    monkeypatch.setattr(hostctl, "process_state", fake_state)
    await client.post(
        "/api/v1/gateway/credentials",
        json={"username": "apibot", "password": SECRET, "mode": "live", "port": 4001},
        cookies=as_user("ADMIN"),
    )
    response = await client.get("/api/v1/gateway", cookies=as_user("ADMIN"))
    assert response.status_code == 200
    assert SECRET not in response.text
    data = response.json()["data"]
    assert data["gateway_username"] == "apibot"
    assert data["process"] == "active"
    assert data["connection_id"] == CONNECTION
    assert "password" not in response.text.lower()


async def test_trader_sees_neither_process_nor_username(client, config):
    response = await client.get("/api/v1/gateway", cookies=as_user("TRADER"))
    data = response.json()["data"]
    assert "gateway_username" not in data
    assert "process" not in data
    assert data["connection_id"] == CONNECTION


async def test_process_requires_admin(client, config):
    response = await client.post(
        "/api/v1/gateway/process", json={"action": "start"}, cookies=as_user("TRADER")
    )
    assert response.status_code == 403


async def test_process_rejects_unknown_action(client, config):
    response = await client.post(
        "/api/v1/gateway/process", json={"action": "reinstall"}, cookies=as_user("ADMIN")
    )
    assert response.status_code == 422


async def test_process_action_is_audited(client, config, stores, monkeypatch):
    _, db = stores

    async def fake_action(action, unit):
        return "active"

    monkeypatch.setattr(hostctl, "process_action", fake_action)
    response = await client.post(
        "/api/v1/gateway/process", json={"action": "restart"}, cookies=as_user("ADMIN")
    )
    assert response.status_code == 200
    assert response.json()["data"] == {"action": "restart", "process": "active"}
    record = await db.audit_logs.find_one({"action": "gateway_process_restart", "user_id": "ADMIN"})
    assert record["data"]["connection"] == CONNECTION


async def test_process_failure_reports_503(client, config, monkeypatch):
    async def failing(action, unit):
        raise RuntimeError("Unit not found")

    monkeypatch.setattr(hostctl, "process_action", failing)
    response = await client.post(
        "/api/v1/gateway/process", json={"action": "start"}, cookies=as_user("ADMIN")
    )
    assert response.status_code == 503
    assert response.json()["success"] is False


async def test_a_tenant_cannot_drive_another_tenants_connection(client, config):
    """Naming a connection id belonging to another tenant is a 404, not a 403.

    The scoped lookup never finds it, so the endpoint cannot even confirm that
    the id exists.
    """
    from tests.conftest import OTHER_CONNECTION

    response = await client.post(
        f"/api/v1/connections/{OTHER_CONNECTION}/process",
        json={"action": "restart"},
        cookies=as_user("ADMIN"),
    )
    assert response.status_code == 404
