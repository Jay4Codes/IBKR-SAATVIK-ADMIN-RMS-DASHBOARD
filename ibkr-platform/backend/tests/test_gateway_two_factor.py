import asyncio
import json

import pytest

from app import gateway_login, hostctl
from app.auth import COOKIE
from app.config import settings
from app.main import app, watch_gateway_logins
from app.state import StateRepository
from tests.conftest import CONNECTION, TENANT

PENDING = {
    "process": "active",
    "api_port_open": False,
    "login_phase": gateway_login.TWO_FACTOR,
    "login_message": "Approve the sign-in request in IBKR Mobile — 140s remaining.",
    "two_factor_started_at": "2026-09-09T10:00:00+05:30",
    "two_factor_timeout_seconds": 180,
    "two_factor_remaining_seconds": 140,
    "two_factor_attempts": 1,
}
IDLE = {
    "process": "active",
    "api_port_open": True,
    "login_phase": gateway_login.LOGGED_IN,
    "login_message": None,
    "two_factor_started_at": None,
    "two_factor_timeout_seconds": None,
    "two_factor_remaining_seconds": None,
    "two_factor_attempts": 0,
}


def as_user(role):
    return {COOKIE: role}


@pytest.fixture
def login(monkeypatch):
    state = {"snapshot": IDLE}

    async def fake_snapshot(connection):
        return {**state["snapshot"], "trading_mode": "live"}

    async def fake_action(action, unit):
        return "active"

    monkeypatch.setattr(gateway_login, "snapshot", fake_snapshot)
    monkeypatch.setattr(hostctl, "process_action", fake_action)
    return state


@pytest.fixture
def repo_for(stores):
    redis, _ = stores
    return StateRepository(redis, TENANT, CONNECTION)


def poller_snapshot(served, snapshots):
    """A snapshot sequence walked independently per connection.

    The poller now covers every supervised gateway, so a single shared counter
    would interleave two connections' sequences and prove nothing about either.
    """

    async def fake_snapshot(connection):
        served.append(connection["_id"])
        seen = served.count(connection["_id"])
        return snapshots[min(seen - 1, len(snapshots) - 1)]

    return fake_snapshot


def polled(served, connection_id=CONNECTION):
    return served.count(connection_id)


def phases_on(entries):
    return [
        json.loads(fields["event"])["data"]["login_phase"]
        for _, fields in entries
        if json.loads(fields["event"])["event_type"] == "gateway.login"
    ]


async def test_admin_sees_the_login_phase_and_countdown(client, login):
    login["snapshot"] = PENDING
    response = await client.get("/api/v1/gateway", cookies=as_user("ADMIN"))
    data = response.json()["data"]
    assert data["login_phase"] == "two_factor"
    assert data["two_factor_remaining_seconds"] == 140
    assert data["two_factor_started_at"] == "2026-09-09T10:00:00+05:30"
    assert data["two_factor_timeout_seconds"] == 180
    assert data["trading_mode"] == "live"
    assert data["api_port_open"] is False


async def test_traders_do_not_see_login_internals(client, login):
    login["snapshot"] = PENDING
    data = (await client.get("/api/v1/gateway", cookies=as_user("TRADER"))).json()["data"]
    for field in ("login_phase", "two_factor_remaining_seconds", "api_port_open", "trading_mode"):
        assert field not in data


async def test_restart_is_refused_while_a_push_is_outstanding(client, login, stores):
    _, db = stores
    login["snapshot"] = PENDING
    response = await client.post(
        "/api/v1/gateway/process", json={"action": "restart"}, cookies=as_user("ADMIN")
    )
    assert response.status_code == 409
    assert "140s left" in response.json()["error"]
    assert await db.audit_logs.find_one({"action": "gateway_process_restart"}) is None


async def test_stop_is_refused_while_a_push_is_outstanding(client, login):
    login["snapshot"] = PENDING
    response = await client.post(
        "/api/v1/gateway/process", json={"action": "stop"}, cookies=as_user("ADMIN")
    )
    assert response.status_code == 409


async def test_start_is_never_blocked(client, login):
    login["snapshot"] = PENDING
    response = await client.post(
        "/api/v1/gateway/process", json={"action": "start"}, cookies=as_user("ADMIN")
    )
    assert response.status_code == 200


async def test_force_overrides_the_guard_and_is_audited(client, login, stores):
    _, db = stores
    login["snapshot"] = PENDING
    response = await client.post(
        "/api/v1/gateway/process",
        json={"action": "restart", "force": True},
        cookies=as_user("ADMIN"),
    )
    assert response.status_code == 200
    record = await db.audit_logs.find_one({"action": "gateway_process_restart"})
    assert record["data"] == {"connection": CONNECTION, "action": "restart", "force": True}


async def test_a_refused_restart_does_not_consume_the_command_rate_limit(client, login):
    login["snapshot"] = PENDING
    blocked = await client.post(
        "/api/v1/gateway/process", json={"action": "restart"}, cookies=as_user("ADMIN")
    )
    assert blocked.status_code == 409
    forced = await client.post(
        "/api/v1/gateway/process",
        json={"action": "restart", "force": True},
        cookies=as_user("ADMIN"),
    )
    assert forced.status_code == 200, "the operator's deliberate retry must not hit a 429"


async def test_a_trader_is_refused_before_the_two_factor_guard_runs(client, login):
    login["snapshot"] = PENDING
    response = await client.post(
        "/api/v1/gateway/process", json={"action": "restart"}, cookies=as_user("TRADER")
    )
    assert response.status_code == 403


async def test_an_expired_push_does_not_block_the_restart_that_fixes_it(client, login):
    login["snapshot"] = {**PENDING, "login_phase": "two_factor_expired", "two_factor_remaining_seconds": 0}
    response = await client.post(
        "/api/v1/gateway/process", json={"action": "restart"}, cookies=as_user("ADMIN")
    )
    assert response.status_code == 200


async def test_a_nearly_expired_push_does_not_block_a_restart(client, login):
    login["snapshot"] = {**PENDING, "two_factor_remaining_seconds": 4}
    response = await client.post(
        "/api/v1/gateway/process", json={"action": "restart"}, cookies=as_user("ADMIN")
    )
    assert response.status_code == 200


async def test_a_restart_clears_the_stale_countdown(client, login, stores, repo_for):
    redis, _ = stores
    await repo_for.set_login(CONNECTION, PENDING, ttl=60)
    assert await redis.get(repo_for.keys.login(CONNECTION))
    response = await client.post(
        "/api/v1/gateway/process",
        json={"action": "restart", "force": True},
        cookies=as_user("ADMIN"),
    )
    assert response.status_code == 200
    assert await redis.get(repo_for.keys.login(CONNECTION)) is None


async def test_stored_login_progress_never_overwrites_worker_state(client, stores, repo_for):
    redis, _ = stores
    before = await redis.get(repo_for.keys.gateway(CONNECTION))
    await repo_for.set_login(CONNECTION, PENDING, ttl=60)
    merged = await repo_for.gateway(CONNECTION)
    assert merged["login_phase"] == "two_factor"
    assert merged["status"] == "DISCONNECTED"
    assert await redis.get(repo_for.keys.gateway(CONNECTION)) == before


async def test_the_poller_streams_only_on_phase_changes(client, stores, monkeypatch, repo_for):
    redis, _ = stores
    served = []
    monkeypatch.setattr(gateway_login, "snapshot", poller_snapshot(served, [PENDING, PENDING, IDLE]))
    monkeypatch.setattr(settings, "gateway_login_poll_seconds", 0.01)

    task = asyncio.create_task(watch_gateway_logins(app))
    while polled(served) < 3:
        await asyncio.sleep(0.01)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)

    assert phases_on(await redis.xrange(repo_for.keys.events)) == ["two_factor", "logged_in"]
    assert await redis.get(repo_for.keys.login(CONNECTION))


async def test_only_one_worker_polls_per_interval(client, stores, monkeypatch, repo_for):
    redis, _ = stores
    served = []
    monkeypatch.setattr(gateway_login, "snapshot", poller_snapshot(served, [PENDING, IDLE]))
    monkeypatch.setattr(settings, "gateway_login_poll_seconds", 0.01)

    tasks = [asyncio.create_task(watch_gateway_logins(app)) for _ in range(2)]
    while polled(served) < 2:
        await asyncio.sleep(0.01)
    await asyncio.sleep(0.05)
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)

    # Two pollers, one phase transition each: the per-connection lock means the
    # second never re-reads a snapshot the first already took.
    assert phases_on(await redis.xrange(repo_for.keys.events)) == ["two_factor", "logged_in"]


async def test_the_poller_compares_against_the_stored_phase(client, stores, monkeypatch, repo_for):
    redis, _ = stores
    await repo_for.set_login(CONNECTION, PENDING, ttl=60)

    async def fake_snapshot(connection):
        return PENDING

    monkeypatch.setattr(gateway_login, "snapshot", fake_snapshot)
    monkeypatch.setattr(settings, "gateway_login_poll_seconds", 0.01)
    task = asyncio.create_task(watch_gateway_logins(app))
    await asyncio.sleep(0.1)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)

    assert phases_on(await redis.xrange(repo_for.keys.events)) == [], (
        "the phase was already two_factor; nothing changed"
    )


async def test_the_poller_survives_a_failing_snapshot(client, monkeypatch, repo_for):
    calls = []

    async def failing(connection):
        calls.append(None)
        raise OSError("log directory vanished")

    monkeypatch.setattr(gateway_login, "snapshot", failing)
    monkeypatch.setattr(settings, "gateway_login_poll_seconds", 0.01)
    task = asyncio.create_task(watch_gateway_logins(app))
    while len(calls) < 3:
        await asyncio.sleep(0.01)
    assert not task.done()
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize("role,expected", [("OWNER", 200), ("ADMIN", 200), ("TRADER", 403), ("VIEWER", 403)])
async def test_tenant_gateway_operator_process(client, stores, login, role, expected):
    _, db = stores
    await db.users.update_one({"_id": "ADMIN"}, {"$set": {"email": "admin@sattvicwealth.in"}})
    await db.tenant_members.update_one({"user_id": "ADMIN", "tenant_id": TENANT}, {"$set": {"role": role}})
    response = await client.post("/api/v1/gateway/process", json={"action": "stop"})
    assert response.status_code == expected
    assert (await client.get("/api/v1/members")).status_code == 403
