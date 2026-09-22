import json

from app.auth import COOKIE, digest
from app.tenancy import COMMAND_CHANNEL, TenantKeys
from tests.conftest import CONNECTION, TENANT

def as_user(role):
    return {COOKIE: role}

def spy_on(redis):
    sent = []
    original = redis.publish

    async def publish(channel, payload):
        sent.append((channel, json.loads(payload)))
        return await original(channel, payload)

    redis.publish = publish
    return sent, original

async def test_reconnect_requires_admin(client):
    response = await client.post("/api/v1/gateway/reconnect", cookies=as_user("TRADER"))
    assert response.status_code == 403
    assert response.json()["success"] is False

async def test_reconnect_requires_session(client):
    client.cookies.clear()
    assert (await client.post("/api/v1/gateway/reconnect")).status_code == 401

async def test_reconnect_publishes_a_targeted_command_and_audits(client, stores):
    redis, db = stores
    sent, original = spy_on(redis)
    try:
        response = await client.post("/api/v1/gateway/reconnect", cookies=as_user("ADMIN"))
    finally:
        redis.publish = original
    assert response.status_code == 200
    assert (
        COMMAND_CHANNEL,
        {"command": "reconnect", "tenant_id": TENANT, "connection_id": CONNECTION},
    ) in sent
    assert await db.audit_logs.find_one({"action": "gateway_reconnect", "user_id": "ADMIN"})

async def test_reconnect_is_rate_limited(client):
    assert (await client.post("/api/v1/gateway/reconnect", cookies=as_user("ADMIN"))).status_code == 200
    second = await client.post("/api/v1/gateway/reconnect", cookies=as_user("ADMIN"))
    assert second.status_code == 429

async def test_rate_limits_are_per_connection(client, stores):
    from app.auth import TENANT_COOKIE
    from tests.conftest import OTHER_TENANT

    assert (await client.post("/api/v1/gateway/reconnect", cookies=as_user("ADMIN"))).status_code == 200
    client.cookies.set(TENANT_COOKIE, OTHER_TENANT)
    assert (await client.post("/api/v1/gateway/reconnect")).status_code == 200

async def test_target_rejects_client_id_zero(client):
    response = await client.post(
        "/api/v1/gateway/target",
        json={"host": "10.0.0.5", "port": 4002, "client_id": 0},
        cookies=as_user("ADMIN"),
    )
    assert response.status_code == 422

async def test_target_rejects_bad_host_and_port(client):
    for payload in (
        {"host": "http://10.0.0.5", "port": 4002, "client_id": 17},
        {"host": "10.0.0.5", "port": 0, "client_id": 17},
        {"host": "10.0.0.5", "port": 70000, "client_id": 17},
    ):
        response = await client.post("/api/v1/gateway/target", json=payload, cookies=as_user("ADMIN"))
        assert response.status_code == 422, payload

async def test_target_requires_admin(client):
    response = await client.post(
        "/api/v1/gateway/target",
        json={"host": "10.0.0.5", "port": 4002, "client_id": 17},
        cookies=as_user("TRADER"),
    )
    assert response.status_code == 403

async def test_target_stores_override_and_triggers_reconnect(client, stores):
    redis, db = stores
    sent, original = spy_on(redis)
    try:
        response = await client.post(
            "/api/v1/gateway/target",
            json={"host": "gw.internal", "port": 4001, "client_id": 21},
            cookies=as_user("ADMIN"),
        )
    finally:
        redis.publish = original
    assert response.status_code == 200
    assert (
        COMMAND_CHANNEL,
        {"command": "reconnect", "tenant_id": TENANT, "connection_id": CONNECTION},
    ) in sent
    stored = json.loads(await redis.get(TenantKeys(TENANT).target(CONNECTION)))
    assert stored == {"host": "gw.internal", "port": 4001, "client_id": 21}
    assert await db.audit_logs.find_one({"action": "gateway_target", "user_id": "ADMIN"})

async def test_unknown_session_cannot_command(client):
    client.cookies.clear()
    response = await client.post("/api/v1/gateway/reconnect", cookies={COOKIE: digest("nonexistent")})
    assert response.status_code == 401
