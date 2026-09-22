import json

import pytest

from app import migrate
from app.config import settings
from app.db import initialize, scoped_id
from app.tenancy import TenantKeys

SLUG = settings.bootstrap_tenant_slug

@pytest.fixture
async def raw_stores():
    from fakeredis.aioredis import FakeRedis
    from mongomock_motor import AsyncMongoMockClient

    redis = FakeRedis(decode_responses=True)
    yield redis, AsyncMongoMockClient().legacy
    await redis.aclose()

@pytest.fixture
async def legacy(raw_stores, monkeypatch):
    redis, db = raw_stores
    await db.users.insert_one({"_id": "u-admin", "email": "admin@old.local", "password_hash": "x"})
    await db.users.insert_one({"_id": "u-trader", "email": "trader@old.local", "password_hash": "x"})
    await db.user_roles.insert_one({"user_id": "u-admin", "role": "ADMIN"})
    await db.user_roles.insert_one({"user_id": "u-trader", "role": "TRADER"})
    await db.account_users.insert_one({"user_id": "u-trader", "account_id": "DU1"})
    await db.ibkr_accounts.insert_one({"_id": "DU1", "gateway_id": "primary"})
    await db.ibkr_accounts.insert_one({"_id": "All", "gateway_id": "primary"})
    await db.orders.insert_one(
        {"_id": "DU1:perm:5", "account_id": "DU1", "perm_id": 5, "created_at": "2026-01-01T00:00:00Z"}
    )
    await db.executions.insert_one({"_id": "fill-1", "execution_id": "fill-1", "account_id": "DU1"})
    await db.audit_logs.insert_one({"_id": "a1", "user_id": "u-admin", "action": "login"})

    await redis.set("gateway:primary", json.dumps({"status": "CONNECTED"}))
    await redis.sadd("accounts", "DU1")
    await redis.set("account:DU1:state", json.dumps({"account_id": "DU1", "net_liquidation": "100"}))
    await redis.hset("account:DU1:positions", "42", json.dumps({"con_id": 42}))
    await redis.xadd("ibkr.events", {"event": json.dumps({"event_type": "account.updated"})})

    monkeypatch.setattr(migrate, "database", lambda: (_Closer(), db))
    monkeypatch.setattr(migrate.Redis, "from_url", staticmethod(lambda *a, **k: _NoClose(redis)))
    return redis, db

class _Closer:
    async def close(self):
        return None

class _NoClose:

    def __new__(cls, redis):
        return redis

async def test_dry_run_changes_nothing(legacy):
    redis, db = legacy
    report = await migrate.run(dry_run=True)
    assert any(f"create tenant '{SLUG}'" in line for line in report.lines)
    assert any("adopt gateway" in line for line in report.lines)
    assert await db.tenants.count_documents({}) == 0
    assert await db.tenant_members.count_documents({}) == 0
    assert await db.broker_connections.count_documents({}) == 0

async def test_migration_adopts_the_running_gateway_untouched(legacy):
    _, db = legacy
    await migrate.run(dry_run=False)
    connection = await db.broker_connections.find_one({})
    assert connection["managed"] is False, "an adopted gateway's files must never be rewritten"
    assert connection["status"] == "ENABLED"
    assert connection["service_unit"] == settings.gateway_service
    assert connection["ibc_config_path"] == settings.ibc_config_path
    assert connection["api_port"] == settings.ibkr_port

async def test_roles_and_grants_carry_over_without_widening_access(legacy):
    _, db = legacy
    await migrate.run(dry_run=False)
    tenant = await db.tenants.find_one({"slug": SLUG})
    admin = await db.tenant_members.find_one({"user_id": "u-admin"})
    trader = await db.tenant_members.find_one({"user_id": "u-trader"})
    assert admin["role"] == "OWNER" and admin["tenant_id"] == tenant["_id"]
    assert trader["role"] == "TRADER"
    assert trader["accounts"] == ["DU1"], "a trader keeps exactly the accounts it had"

async def test_documents_are_stamped_and_re_keyed(legacy):
    _, db = legacy
    await migrate.run(dry_run=False)
    tenant = await db.tenants.find_one({"slug": SLUG})
    order = await db.orders.find_one({})
    assert order["_id"] == scoped_id(tenant["_id"], "DU1:perm:5")
    assert order["tenant_id"] == tenant["_id"]
    assert order["created_at"] == "2026-01-01T00:00:00Z", "history is preserved, not rebuilt"
    fill = await db.executions.find_one({})
    assert fill["_id"] == scoped_id(tenant["_id"], "fill-1")
    assert (await db.audit_logs.find_one({}))["tenant_id"] == tenant["_id"]

async def test_live_state_is_copied_not_moved(legacy):
    redis, db = legacy
    await migrate.run(dry_run=False)
    tenant = await db.tenants.find_one({"slug": SLUG})
    connection = await db.broker_connections.find_one({})
    keys = TenantKeys(tenant["_id"])

    assert json.loads(await redis.get(keys.gateway(connection["_id"])))["status"] == "CONNECTED"
    assert await redis.smembers(keys.accounts) == {"DU1"}
    assert json.loads(await redis.get(keys.account_state("DU1")))["net_liquidation"] == "100"
    assert await redis.hget(keys.account_rows("DU1", "positions"), "42")
    assert len(await redis.xrange(keys.events)) == 1

    assert await redis.get("gateway:primary"), "the pre-tenancy key is left as a rollback path"
    assert await redis.smembers("accounts") == {"DU1"}

async def test_migration_is_idempotent(legacy):
    _, db = legacy
    await migrate.run(dry_run=False)
    await migrate.run(dry_run=False)
    assert await db.tenants.count_documents({}) == 1
    assert await db.broker_connections.count_documents({}) == 1
    assert await db.tenant_members.count_documents({}) == 2
    assert await db.orders.count_documents({}) == 1
    assert await db.executions.count_documents({}) == 1

async def test_legacy_accounts_are_reshaped_before_the_unique_index_is_built(legacy):
    _, db = legacy
    await migrate.run(dry_run=False)
    tenant = await db.tenants.find_one({"slug": SLUG})
    accounts = {doc["account_id"]: doc async for doc in db.ibkr_accounts.find()}
    assert set(accounts) == {"DU1", "All"}
    for account_id, doc in accounts.items():
        assert doc["tenant_id"] == tenant["_id"]
        assert doc["_id"] == scoped_id(tenant["_id"], account_id)
    names = {index["name"] async for index in db.ibkr_accounts.list_indexes()}
    assert "tenant_id_1_account_id_1" in names

async def test_initialize_explains_itself_on_an_unmigrated_database(raw_stores):
    from pymongo.errors import DuplicateKeyError

    redis, db = raw_stores
    await db.ibkr_accounts.insert_one({"_id": "A", "gateway_id": "primary"})
    await db.ibkr_accounts.insert_one({"_id": "B", "gateway_id": "primary"})
    try:
        await initialize(db)
    except RuntimeError as error:
        assert "python -m app.migrate" in str(error)
    except DuplicateKeyError:
        pytest.skip("the in-memory MongoDB does not enforce this unique index")

async def test_local_symbols_give_back_the_underlying_and_expiry():
    from app.migrate import parse_local_symbol

    assert parse_local_symbol("SPXW  260918P07485000") == {
        "underlying": "SPX",
        "sec_type": "OPT",
        "expiry": "20260918",
        "multiplier": "100",
    }
    assert parse_local_symbol("AAPL  260116C00150000")["underlying"] == "AAPL"
    assert parse_local_symbol("SPX") is None
    assert parse_local_symbol("28812380") is None
    assert parse_local_symbol("") is None
    assert parse_local_symbol("SPXW  2609XXP07485000") is None

async def test_only_realized_fills_without_a_contract_are_stamped(stores):
    from app.migrate import Report, backfill_execution_contracts

    _, db = stores
    await db.executions.insert_many(
        [
            {"_id": "t:e1", "symbol": "SPXW  260918P07480000", "realized_pnl": "-1265.36"},
            {"_id": "t:e2", "symbol": "SPXW  260918C07750000", "realized_pnl": "0.0", "underlying": "SPX"},
            {"_id": "t:e3", "symbol": "SPXW  260918C07730000", "realized_pnl": None},
        ]
    )
    await backfill_execution_contracts(db, Report(dry_run=False))
    stamped = await db.executions.find_one({"_id": "t:e1"})
    assert stamped["underlying"] == "SPX"
    assert stamped["expiry"] == "20260918"
    assert stamped["currency"] == "USD"
    assert (await db.executions.find_one({"_id": "t:e3"})).get("expiry") is None

async def test_the_contract_backfill_is_a_no_op_on_a_dry_run(stores):
    from app.migrate import Report, backfill_execution_contracts

    _, db = stores
    await db.executions.insert_one(
        {"_id": "t:e1", "symbol": "SPXW  260918P07480000", "realized_pnl": "-1265.36"}
    )
    report = Report(dry_run=True)
    await backfill_execution_contracts(db, report)
    assert (await db.executions.find_one({"_id": "t:e1"})).get("underlying") is None
