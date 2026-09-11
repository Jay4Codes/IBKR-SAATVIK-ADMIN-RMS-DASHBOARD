import os

# Set before app.config is imported. Environment wins over the dotenv file, so
# these hold even on a host whose backend/.env describes a real deployment.
os.environ["CORS_ORIGINS"] = "http://localhost:3000"
os.environ["COOKIE_SECURE"] = "false"
os.environ["SECRET_KEY"] = "testing-secret-key"
os.environ["BOOTSTRAP_TENANT_SLUG"] = "bootstrap-tenant"
os.environ["BOOTSTRAP_TENANT_NAME"] = "Bootstrap Tenant"
os.environ["IBKR_HOST"] = "127.0.0.1"
os.environ["IBKR_PORT"] = "4001"
os.environ["IBC_CONFIG_PATH"] = "/opt/ibc/config.ini"
os.environ["IBC_LOG_DIRECTORY"] = "/opt/ibc/logs"
os.environ["GATEWAY_SERVICE"] = "ibkr-gateway.service"
# A configured vendor feed on the developer's host must not reach into the suite
# and start it polling; tests that want it on patch these in.
os.environ["MASSIVE_API_KEY"] = ""
os.environ["MASSIVE_UNDERLYINGS"] = ""

import pytest
from fakeredis.aioredis import FakeRedis
from httpx import ASGITransport, AsyncClient
from mongomock_motor import AsyncMongoMockClient

from app import connections as registry
from app.auth import COOKIE, TENANT_COOKIE, digest, passwords
from app.db import initialize
from app.domain import AccountState, Event
from app.main import app
from app.state import StateRepository
from app.tenancy import TenantKeys, new_tenant

TENANT = "tenant-one"
OTHER_TENANT = "tenant-two"
CONNECTION = "connection-one"
OTHER_CONNECTION = "connection-two"


def gateway_connection(tenant_id: str, connection_id: str, name: str, port: int) -> dict:
    """An adopted IB Gateway connection: no files are provisioned for it."""
    return {
        "_id": connection_id,
        "tenant_id": tenant_id,
        "name": name,
        "provider": registry.Provider.IBKR_GATEWAY.value,
        "status": registry.ConnectionStatus.ENABLED.value,
        "managed": False,
        "host": "127.0.0.1",
        "api_port": port,
        "client_id": 17,
        "trading_mode": "paper",
        "account_filter": "",
        "ibc_config_path": None,
        "ibc_log_directory": None,
        "service_unit": "ibkr-gateway-test.service",
    }


async def seed_tenant(db, redis, tenant_id: str, connection_id: str, accounts, port: int):
    tenant = {**new_tenant(tenant_id.replace("-", " ").title(), tenant_id), "_id": tenant_id}
    await db.tenants.insert_one(tenant)
    await db.broker_connections.insert_one(
        gateway_connection(tenant_id, connection_id, f"Gateway {tenant_id}", port)
    )
    repo = StateRepository(redis, tenant_id, connection_id)
    for account in accounts:
        state = AccountState(account_id=account, net_liquidation="1000", currency="USD")
        await repo.publish(
            Event(event_type="account.updated", account_id=account, data=state.model_dump(mode="json"))
        )
    return repo


async def add_user(db, redis, user_id: str, tenant_id: str, role: str, accounts=(), super_admin=False):
    if not await db.users.find_one({"_id": user_id}):
        await db.users.insert_one(
            {
                "_id": user_id,
                "email": "ekalon.consulting@gmail.com" if user_id == "ADMIN" else f"{user_id.lower()}@test.local",
                "password_hash": passwords.hash("testing-password"),
                "is_super_admin": super_admin,
                "status": "ACTIVE",
            }
        )
        await redis.set(f"session:{digest(user_id)}", user_id)
    await db.tenant_members.insert_one(
        {
            "_id": f"{tenant_id}:{user_id}",
            "tenant_id": tenant_id,
            "user_id": user_id,
            "role": role,
            "accounts": list(accounts),
            "status": "ACTIVE",
        }
    )


@pytest.fixture
async def stores():
    redis = FakeRedis(decode_responses=True)
    db = AsyncMongoMockClient().test
    await initialize(db)
    yield redis, db
    await redis.aclose()


@pytest.fixture
async def keys():
    return TenantKeys(TENANT)


@pytest.fixture
async def repo(stores):
    redis, _ = stores
    return StateRepository(redis, TENANT, CONNECTION)


@pytest.fixture
async def client(stores):
    """An API client signed in as tenant-one's OWNER.

    Also seeds a second tenant with its own gateway and accounts, so every
    isolation assertion has something real to leak from.
    """
    redis, db = stores
    app.state.redis, app.state.db = redis, db
    await seed_tenant(db, redis, TENANT, CONNECTION, ("DU1", "DU2"), 4101)
    await seed_tenant(db, redis, OTHER_TENANT, OTHER_CONNECTION, ("DU9",), 4102)
    await add_user(db, redis, "ADMIN", TENANT, "OWNER")
    await add_user(db, redis, "TRADER", TENANT, "TRADER", accounts=["DU1"])
    await add_user(db, redis, "OUTSIDER", OTHER_TENANT, "OWNER")
    await add_user(db, redis, "SUPER", OTHER_TENANT, "OWNER", super_admin=True)
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        cookies={COOKIE: "ADMIN", TENANT_COOKIE: TENANT},
        headers={"Origin": "http://localhost:3000"},
    ) as client:
        yield client


async def promote_super(stores):
    """Move the designated identity to the cross-tenant admin test account."""
    _, db = stores
    await db.users.update_one({"_id": "ADMIN"}, {"$set": {"email": "admin@test.local"}})
    await db.users.update_one({"_id": "SUPER"}, {"$set": {"email": "ekalon.consulting@gmail.com"}})
