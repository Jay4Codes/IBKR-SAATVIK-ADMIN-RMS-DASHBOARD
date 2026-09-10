from pymongo import ASCENDING, DESCENDING, AsyncMongoClient
from pymongo.errors import DuplicateKeyError, OperationFailure

from app.config import settings
from app.domain import order_key


def database():
    client = AsyncMongoClient(settings.mongodb_uri, serverSelectionTimeoutMS=3000, tz_aware=True)
    return client, client[settings.mongodb_database]


async def initialize(db):
    try:
        await _create_indexes(db)
    except (DuplicateKeyError, OperationFailure) as exc:
        # Almost always a pre-tenancy database: the unique tenant-scoped indexes
        # cannot be built while documents still lack a tenant_id. Say so, rather
        # than letting a raw duplicate-key error crash-loop the service.
        raise RuntimeError(
            "Could not create the tenant-scoped indexes. If this database predates "
            "multi-tenancy, run `python -m app.migrate` before starting the API or "
            f"worker — it stamps existing documents with a tenant. Underlying error: {exc}"
        ) from exc


async def _create_indexes(db):
    # Platform scope: identity is shared across tenants so one person can hold
    # memberships in several of them under a single login.
    await db.users.create_index("email", unique=True)
    await db.user_roles.create_index([("user_id", ASCENDING), ("role", ASCENDING)], unique=True)

    await db.tenants.create_index("slug", unique=True)
    await db.tenants.create_index("status")

    # Tenant scope. Every index leads with tenant_id so a scoped query is also
    # the fast query, and a query that forgot its scope cannot ride an index.
    await db.tenant_members.create_index(
        [("tenant_id", ASCENDING), ("user_id", ASCENDING)], unique=True
    )
    await db.tenant_members.create_index([("user_id", ASCENDING), ("status", ASCENDING)])
    await db.account_users.create_index(
        [("tenant_id", ASCENDING), ("user_id", ASCENDING), ("account_id", ASCENDING)], unique=True
    )
    await db.broker_connections.create_index(
        [("tenant_id", ASCENDING), ("name", ASCENDING)], unique=True
    )
    await db.broker_connections.create_index([("tenant_id", ASCENDING), ("status", ASCENDING)])
    await db.broker_connections.create_index("api_port", sparse=True)
    await db.ibkr_accounts.create_index([("tenant_id", ASCENDING), ("account_id", ASCENDING)], unique=True)
    await db.orders.create_index(
        [("tenant_id", ASCENDING), ("account_id", ASCENDING), ("updated_at", ASCENDING)]
    )
    await db.executions.create_index(
        [("tenant_id", ASCENDING), ("account_id", ASCENDING), ("executed_at", ASCENDING)]
    )
    await db.order_events.create_index([("tenant_id", ASCENDING), ("account_id", ASCENDING)])
    await db.audit_logs.create_index([("tenant_id", ASCENDING), ("timestamp", DESCENDING)])
    await db.visibility_tests.create_index([("tenant_id", ASCENDING), ("checked_at", DESCENDING)])

    for role in ("ADMIN", "TRADER"):
        await db.roles.update_one({"_id": role}, {"$setOnInsert": {"name": role}}, upsert=True)


def scoped_id(tenant_id: str, *parts: str) -> str:
    """A document _id that carries its tenant, so two tenants can hold the same
    broker identifier (account, permId, execId) without colliding."""
    return ":".join((tenant_id, *parts))


async def persist(db, event, *, tenant_id: str, connection_id: str):
    """Write one live event into the tenant's durable history.

    Idempotent by construction: order snapshots replace by key, order events and
    executions insert-once. Replaying an unacknowledged stream entry is safe.
    """
    data = {**event.data, "tenant_id": tenant_id, "connection_id": connection_id}
    kind = event.event_type
    if kind.startswith("gateway."):
        await db.broker_connections.update_one(
            {"_id": connection_id, "tenant_id": tenant_id},
            {"$set": {"last_state": event.data, "last_state_at": event.timestamp}},
        )
    elif kind == "account.updated":
        await db.ibkr_accounts.update_one(
            {"tenant_id": tenant_id, "account_id": event.account_id},
            {
                "$set": {"connection_id": connection_id, "updated_at": event.timestamp},
                "$setOnInsert": {"tenant_id": tenant_id, "account_id": event.account_id},
            },
            upsert=True,
        )
    elif kind.startswith("order."):
        key = scoped_id(tenant_id, order_key(event.data))
        previous = await db.orders.find_one({"_id": key})
        provisional_key = scoped_id(
            tenant_id, f"{event.account_id}:{event.data['client_id']}:{event.data['order_id']}"
        )
        provisional = None
        if key != provisional_key:
            provisional = await db.orders.find_one({"_id": provisional_key})
        previous = previous or provisional
        if previous:
            data = {**data, "created_at": previous["created_at"]}
        await db.orders.replace_one({"_id": key}, {"_id": key, **data}, upsert=True)
        if provisional:
            await db.orders.delete_one({"_id": provisional_key})
        await db.order_events.update_one(
            {"_id": event.event_id},
            {
                "$setOnInsert": {
                    **event.model_dump(mode="json"),
                    "tenant_id": tenant_id,
                    "connection_id": connection_id,
                }
            },
            upsert=True,
        )
    elif kind == "execution.created":
        execution_id = scoped_id(tenant_id, data["execution_id"])
        await db.executions.update_one({"_id": execution_id}, {"$setOnInsert": data}, upsert=True)
        # A late commission report enriches money fields only; the immutable
        # facts of the fill are never rewritten.
        enrichment = {key: data[key] for key in ("commission", "realized_pnl") if data.get(key) is not None}
        if enrichment:
            await db.executions.update_one({"_id": execution_id}, {"$set": enrichment})
