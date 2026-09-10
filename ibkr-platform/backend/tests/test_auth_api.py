import pytest
from fastapi import HTTPException

from app.auth import COOKIE, TENANT_COOKIE, subscriptions
from app.tenancy import Membership, Principal, TenantRole
from tests.conftest import OTHER_TENANT, TENANT, promote_super


def principal(role: TenantRole, accounts=(), super_admin=False) -> Principal:
    membership = Membership(TENANT, "t1", "T1", "ACTIVE", role, tuple(accounts))
    return Principal("u", "u@test.local", super_admin, (membership,), membership)


@pytest.mark.parametrize("accounts", [["*"], ["DU2"], ["DU1", "DU2"]])
def test_trader_scope(accounts):
    with pytest.raises(HTTPException) as error:
        subscriptions(principal(TenantRole.TRADER, ["DU1"]), accounts)
    assert error.value.status_code == 403


def test_admin_and_trader_subscriptions():
    assert subscriptions(principal(TenantRole.OWNER, super_admin=True), ["*"]) == {"*"}
    assert subscriptions(principal(TenantRole.TRADER, ["DU1"]), ["DU1"]) == {"DU1"}
    principal(TenantRole.ADMIN).require_account("DU2")


def test_viewer_is_not_a_tenant_admin():
    assert not principal(TenantRole.VIEWER, ["DU1"]).is_tenant_admin
    assert principal(TenantRole.VIEWER, ["DU1"]).sees("DU1")
    assert not principal(TenantRole.VIEWER, ["DU1"]).sees("DU2")


async def test_account_routes_and_authorization(client):
    assert (await client.get("/api/v1/accounts")).json()["success"]
    assert len((await client.get("/api/v1/accounts")).json()["data"]) == 2
    client.cookies.set(COOKIE, "TRADER")
    assert len((await client.get("/api/v1/accounts")).json()["data"]) == 1
    for suffix in ("", "/positions", "/orders", "/executions", "/summary"):
        assert (await client.get(f"/api/v1/accounts/DU2{suffix}")).status_code == 403
        response = await client.get(f"/api/v1/accounts/DU1{suffix}")
        assert response.status_code == 200
        assert response.json()["success"] is True
    assert (await client.get("/api/v1/admin/diagnostics")).status_code == 403


async def test_missing_account_and_unauthorized(client):
    assert (await client.get("/api/v1/accounts/NOPE")).status_code == 404
    client.cookies.clear()
    assert (await client.get("/api/v1/accounts")).status_code == 401


async def test_login_logout_cookie_and_csrf(client):
    client.cookies.clear()
    response = await client.post(
        "/api/v1/auth/login", json={"email": "ekalon.consulting@gmail.com", "password": "testing-password"}
    )
    assert response.status_code == 200
    assert "HttpOnly" in response.headers["set-cookie"]
    body = response.json()["data"]
    assert body["role"] == "ADMIN"
    assert body["tenant"]["tenant_id"] == TENANT
    assert (await client.get("/api/v1/auth/me")).json()["data"]["role"] == "ADMIN"
    response = await client.post("/api/v1/auth/logout", json={}, headers={"Origin": "https://evil.test"})
    assert response.status_code == 403
    assert (await client.post("/api/v1/auth/logout", json={})).status_code == 200
    assert (await client.get("/api/v1/auth/me")).status_code == 401


async def test_login_throttle(client):
    for _ in range(5):
        response = await client.post(
            "/api/v1/auth/login", json={"email": "missing@test.local", "password": "bad"}
        )
        assert response.status_code == 401
    assert (
        await client.post("/api/v1/auth/login", json={"email": "missing@test.local", "password": "bad"})
    ).status_code == 429


async def test_visibility_requires_a_healthy_connection(client):
    from app.domain import now

    response = await client.post(
        "/api/v1/admin/diagnostics/visibility",
        json={"account_id": "DU1", "perm_id": 1, "started_at": now().isoformat()},
    )
    assert response.status_code == 409
    assert "healthy live connection" in response.json()["error"]


async def test_live_visibility_requires_correlated_quantity_change(client, stores, repo, keys):
    from datetime import timedelta

    from app.db import persist
    from app.domain import Event, GatewayState, now

    redis, db = stores
    await redis.set(
        keys.gateway("connection-one"),
        GatewayState(status="CONNECTED", last_heartbeat=now()).model_dump_json(),
    )
    started = now() - timedelta(seconds=5)
    order = {
        "account_id": "DU1",
        "perm_id": 99,
        "client_id": 0,
        "order_id": 0,
        "status": "Filled",
        "filled_quantity": "2",
        "con_id": 123,
        "created_at": now().isoformat(),
        "updated_at": now().isoformat(),
    }
    fill = {
        "account_id": "DU1",
        "execution_id": "external1",
        "perm_id": 99,
        "con_id": 123,
        "executed_at": now().isoformat(),
    }
    for kind, data in (("order.filled", order), ("execution.created", fill)):
        event = Event(event_type=kind, account_id="DU1", data=data)
        await repo.publish(event)
        await persist(db, event, tenant_id=TENANT, connection_id="connection-one")
    await repo.publish(
        Event(event_type="position.updated", account_id="DU1", data={"con_id": 999, "quantity_changed": True})
    )
    body = {
        "account_id": "DU1",
        "perm_id": 99,
        "execution_id": "external1",
        "started_at": started.isoformat(),
        "expected_working_perm_ids": [800],
    }
    response = await client.post("/api/v1/admin/diagnostics/visibility", json=body)
    assert response.status_code == 200
    assert response.json()["data"]["external_execution_visibility"] == "FAIL"
    assert response.json()["data"]["working_orders_visibility"] == "FAIL"
    await repo.publish(
        Event(event_type="position.updated", account_id="DU1", data={"con_id": 123, "quantity_changed": True})
    )
    response = await client.post("/api/v1/admin/diagnostics/visibility", json=body)
    assert response.json()["data"]["external_order_visibility"] == "PASS"
    assert response.json()["data"]["external_execution_visibility"] == "PASS"


async def test_tenant_data_never_crosses_the_boundary(client):
    """The other tenant's account exists, and is invisible from this one."""
    assert {a["account_id"] for a in (await client.get("/api/v1/accounts")).json()["data"]} == {"DU1", "DU2"}
    assert (await client.get("/api/v1/accounts/DU9")).status_code == 404

    client.cookies.set(COOKIE, "OUTSIDER")
    client.cookies.set(TENANT_COOKIE, OTHER_TENANT)
    assert {a["account_id"] for a in (await client.get("/api/v1/accounts")).json()["data"]} == {"DU9"}
    for account in ("DU1", "DU2"):
        assert (await client.get(f"/api/v1/accounts/{account}")).status_code == 404


async def test_membership_is_required_to_name_a_tenant(client):
    """Naming another tenant's id does not grant access to it."""
    client.cookies.set(COOKIE, "TRADER")
    client.cookies.set(TENANT_COOKIE, OTHER_TENANT)
    response = await client.get("/api/v1/accounts")
    assert response.status_code == 403
    assert "not a member" in response.json()["error"]


async def test_super_admin_may_act_inside_any_tenant(client, stores):
    await promote_super(stores)
    client.cookies.set(COOKIE, "SUPER")
    client.cookies.set(TENANT_COOKIE, TENANT)
    response = await client.get("/api/v1/accounts")
    assert response.status_code == 200
    assert {a["account_id"] for a in response.json()["data"]} == {"DU1", "DU2"}
    me = (await client.get("/api/v1/auth/me")).json()["data"]
    assert me["impersonating"] is True
    assert me["is_super_admin"] is True


async def test_tenant_switch_sets_the_active_tenant(client, stores):
    await promote_super(stores)
    client.cookies.set(COOKIE, "SUPER")
    response = await client.post("/api/v1/tenants/switch", json={"tenant": TENANT})
    assert response.status_code == 200
    assert response.json()["data"]["tenant"]["tenant_id"] == TENANT
    assert TENANT in response.headers["set-cookie"]


async def test_suspended_tenant_is_refused(client, stores):
    _, db = stores
    client.cookies.set(COOKIE, "TRADER")
    await db.tenants.update_one({"_id": TENANT}, {"$set": {"status": "SUSPENDED"}})
    response = await client.get("/api/v1/accounts")
    # With its only tenant suspended, the membership disappears and there is
    # nothing left to act inside.
    assert response.status_code == 403
