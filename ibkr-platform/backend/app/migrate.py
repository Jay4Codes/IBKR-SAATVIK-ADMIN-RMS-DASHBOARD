"""Migrate a pre-tenancy installation onto the multi-tenant model.

Everything the single-gateway platform owned becomes the property of one
bootstrap tenant, and the IB Gateway already running on this host is *adopted*
rather than re-provisioned — its `/opt/ibc/config.ini`, its port, and its
`ibkr-gateway.service` unit stay exactly where they are, so a live broker
session is never disturbed by the migration.

Idempotent: every step checks before it writes, so re-running after a partial
run finishes the job instead of duplicating it.

    python -m app.migrate --dry-run     # report what would change
    python -m app.migrate               # apply
"""

from __future__ import annotations

import argparse
import asyncio
import json
from typing import Any

from redis.asyncio import Redis

from app import connections as registry
from app.config import settings
from app.db import database, initialize, scoped_id
from app.tenancy import TenantKeys, new_tenant, now

#: Collections that gain a tenant_id, and the id prefix rule for each.
BACKFILL = (
    "orders",
    "order_events",
    "executions",
    "audit_logs",
    "visibility_tests",
    "ibkr_accounts",
    "account_users",
)
#: Collections whose `_id` must be re-keyed so two tenants can hold the same
#: broker identifier without colliding, and the field the new key is built from.
REKEYED = {"orders": None, "executions": "execution_id", "ibkr_accounts": "account_id"}
#: How much of the legacy event stream to carry over. History already lives in
#: MongoDB; the stream only backs the diagnostics window and visibility tests.
STREAM_LIMIT = 20000


class Report:
    def __init__(self, dry_run: bool):
        self.dry_run = dry_run
        self.lines: list[str] = []

    def say(self, message: str) -> None:
        self.lines.append(message)
        print(("would " if self.dry_run else "") + message)


async def ensure_bootstrap_tenant(db, report: Report) -> dict[str, Any]:
    existing = await db.tenants.find_one({"slug": settings.bootstrap_tenant_slug})
    if existing:
        report.say(f"reuse tenant '{existing['slug']}' ({existing['_id']})")
        return existing
    tenant = new_tenant(settings.bootstrap_tenant_name, settings.bootstrap_tenant_slug)
    report.say(f"create tenant '{tenant['slug']}' ({tenant['_id']})")
    if not report.dry_run:
        await db.tenants.insert_one(tenant)
    return tenant


async def migrate_members(db, tenant: dict[str, Any], report: Report) -> None:
    """Turn platform roles and account grants into tenant memberships.

    A pre-tenancy ADMIN becomes the tenant's OWNER; a TRADER keeps exactly the
    accounts it was granted. Nobody gains access they did not already have.
    """
    tenant_id = tenant["_id"]
    async for user in db.users.find():
        user_id = user["_id"]
        if await db.tenant_members.find_one({"tenant_id": tenant_id, "user_id": user_id}):
            continue
        roles = {row["role"] async for row in db.user_roles.find({"user_id": user_id})}
        role = "OWNER" if "ADMIN" in roles else "TRADER"
        accounts = [
            row["account_id"]
            async for row in db.account_users.find({"user_id": user_id})
        ]
        report.say(f"add {user['email']} to '{tenant['slug']}' as {role} with {len(accounts)} accounts")
        if report.dry_run:
            continue
        await db.tenant_members.insert_one(
            {
                "_id": f"{tenant_id}:{user_id}",
                "tenant_id": tenant_id,
                "user_id": user_id,
                "role": role,
                "accounts": accounts,
                "status": "ACTIVE",
                "created_at": now(),
            }
        )
        await db.users.update_one({"_id": user_id}, {"$set": {"default_tenant_id": tenant_id}})


async def adopt_gateway(db, tenant: dict[str, Any], report: Report) -> dict[str, Any]:
    """Register the gateway this host already runs, without touching its files.

    `managed=False` is the whole point: provisioning will never rewrite an
    adopted connection's config or delete its unit, because those predate this
    platform's ownership of them.
    """
    tenant_id = tenant["_id"]
    existing = await db.broker_connections.find_one({"tenant_id": tenant_id, "managed": False})
    if existing:
        report.say(f"reuse adopted connection '{existing['name']}' ({existing['_id']})")
        return existing
    doc = registry.new_connection(
        tenant_id,
        "Primary IB Gateway",
        registry.Provider.IBKR_GATEWAY,
        managed=False,
        status=registry.ConnectionStatus.ENABLED.value,
        host=settings.ibkr_host,
        api_port=settings.ibkr_port,
        client_id=settings.ibkr_client_id,
        account_filter=settings.ibkr_account,
        ibc_config_path=settings.ibc_config_path,
        ibc_log_directory=settings.ibc_log_directory,
        launcher_log=settings.gateway_launcher_log or None,
        service_unit=settings.gateway_service,
    )
    report.say(
        f"adopt gateway {settings.ibkr_host}:{settings.ibkr_port} "
        f"(unit {settings.gateway_service}, config {settings.ibc_config_path}) as {doc['_id']}"
    )
    if not report.dry_run:
        await db.broker_connections.insert_one(doc)
    return doc


async def reshape_accounts(db, tenant: dict[str, Any], report: Report) -> None:
    """Give legacy account documents the fields the tenant-scoped index needs.

    The pre-tenancy shape was `{_id: <account number>, gateway_id: "primary"}`,
    with no `account_id` field at all. Left as-is, every one of them collides on
    the new unique `(tenant_id, account_id)` index as `(null, null)` — which is
    why this runs before any index is created.
    """
    stale = [doc async for doc in db.ibkr_accounts.find({"account_id": {"$exists": False}})]
    if not stale:
        return
    report.say(f"give {len(stale)} ibkr_accounts documents an account_id")
    if report.dry_run:
        return
    for doc in stale:
        await db.ibkr_accounts.update_one(
            {"_id": doc["_id"]},
            {"$set": {"account_id": str(doc["_id"]), "tenant_id": tenant["_id"]}},
        )


async def backfill_documents(db, tenant: dict[str, Any], connection_id: str, report: Report) -> None:
    tenant_id = tenant["_id"]
    await reshape_accounts(db, tenant, report)
    for name in BACKFILL:
        collection = db[name]
        pending = await collection.count_documents({"tenant_id": {"$exists": False}})
        if not pending:
            continue
        report.say(f"stamp {pending} {name} documents with tenant_id")
        if report.dry_run:
            continue
        await collection.update_many(
            {"tenant_id": {"$exists": False}},
            {"$set": {"tenant_id": tenant_id, "connection_id": connection_id}},
        )

    for name, source in REKEYED.items():
        collection = db[name]
        stale = [
            doc
            async for doc in collection.find({"_id": {"$not": {"$regex": f"^{tenant_id}:"}}})
        ]
        if not stale:
            continue
        report.say(f"re-key {len(stale)} {name} documents under the tenant")
        if report.dry_run:
            continue
        for doc in stale:
            old = doc.pop("_id")
            # The new key carries the tenant, so two tenants may hold the same
            # account number, permId, or execution id.
            suffix = doc.get(source, old) if source else old
            key = scoped_id(tenant_id, str(suffix))
            await collection.replace_one({"_id": key}, {"_id": key, **doc}, upsert=True)
            await collection.delete_one({"_id": old})


async def migrate_redis(redis, tenant: dict[str, Any], connection_id: str, report: Report) -> None:
    """Move live state and the event stream into the tenant's namespace.

    Copied rather than renamed, so the pre-tenancy keys survive as a rollback
    path until an operator removes them.
    """
    keys = TenantKeys(tenant["_id"])

    legacy_gateway = await redis.get("gateway:primary")
    if legacy_gateway and not await redis.exists(keys.gateway(connection_id)):
        report.say("copy gateway:primary into the tenant namespace")
        if not report.dry_run:
            await redis.set(keys.gateway(connection_id), legacy_gateway)

    accounts = await redis.smembers("accounts")
    if accounts and not await redis.exists(keys.accounts):
        report.say(f"copy {len(accounts)} account ids into the tenant namespace")
        if not report.dry_run:
            await redis.sadd(keys.accounts, *accounts)
            await redis.sadd(keys.connection_accounts(connection_id), *accounts)

    for account in accounts:
        state = await redis.get(f"account:{account}:state")
        if state and not await redis.exists(keys.account_state(account)):
            report.say(f"copy account {account} state")
            if not report.dry_run:
                await redis.set(keys.account_state(account), state)
        for kind in ("positions", "orders"):
            rows = await redis.hgetall(f"account:{account}:{kind}")
            if rows and not await redis.exists(keys.account_rows(account, kind)):
                report.say(f"copy account {account} {kind} ({len(rows)} rows)")
                if not report.dry_run:
                    await redis.hset(keys.account_rows(account, kind), mapping=rows)
        marks = await redis.hgetall(f"diagnostics:{account}")
        if marks and not await redis.exists(keys.diagnostics(account)):
            if not report.dry_run:
                await redis.hset(keys.diagnostics(account), mapping=marks)

    target = await redis.get("gateway:primary:target")
    if target and not await redis.exists(keys.target(connection_id)):
        report.say("copy the runtime connection target override")
        if not report.dry_run:
            await redis.set(keys.target(connection_id), target)

    if await redis.exists(keys.events):
        report.say(f"leave {keys.events} alone — it already exists")
        return
    entries = await redis.xrevrange("ibkr.events", count=STREAM_LIMIT)
    if not entries:
        return
    report.say(f"copy the newest {len(entries)} events into {keys.events}")
    if report.dry_run:
        return
    for event_id, fields in reversed(entries):
        # The original ids are preserved: the diagnostics window and the
        # visibility test both range over the stream by millisecond id.
        await redis.xadd(keys.events, {**fields, "connection_id": connection_id}, id=event_id)


async def run(dry_run: bool) -> Report:
    report = Report(dry_run)
    client, db = database()
    redis = Redis.from_url(settings.redis_url, decode_responses=True)
    try:
        tenant = await ensure_bootstrap_tenant(db, report)
        connection = await adopt_gateway(db, tenant, report)
        await migrate_members(db, tenant, report)
        await backfill_documents(db, tenant, connection["_id"], report)
        # Indexes come last. Several of them are unique over `tenant_id`, so
        # building them before the documents carry one fails on a real database
        # — and would leave the API unable to start.
        if not dry_run:
            report.say("create the tenant-scoped indexes")
            await initialize(db)
        await migrate_redis(redis, tenant, connection["_id"], report)
        report.say(
            "done — restart ibkr-api and ibkr-worker to pick up the tenant-scoped keys"
            if not dry_run
            else "finish (nothing was written)"
        )
    finally:
        await redis.aclose()
        await client.close()
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="report changes without writing")
    parser.add_argument("--json", action="store_true", help="emit the report as JSON")
    args = parser.parse_args()
    report = asyncio.run(run(args.dry_run))
    if args.json:
        print(json.dumps({"dry_run": args.dry_run, "steps": report.lines}, indent=2))


if __name__ == "__main__":
    main()
