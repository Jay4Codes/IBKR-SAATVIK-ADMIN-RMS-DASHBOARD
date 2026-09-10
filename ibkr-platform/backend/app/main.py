import asyncio
import json
import logging
import secrets as random_secrets
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from decimal import Decimal
from typing import Literal
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import AwareDatetime, BaseModel, Field
from redis.asyncio import Redis

from app import connections as registry
from app import gateway_login, hostctl, provisioning, secrets, snaptrade
from app.auth import (
    COOKIE,
    DUMMY_HASH,
    TENANT_COOKIE,
    audit,
    digest,
    identity,
    passwords,
    requested_tenant,
    require_gateway_operator,
    require_super_admin,
    require_tenant,
    require_tenant_admin,
    require_user,
    subscriptions,
)
from app.config import settings
from app.db import database, initialize
from app.domain import now
from app.logging import configure
from app.state import StateRepository
from app.tenancy import (
    COMMAND_CHANNEL,
    Principal,
    TenantRole,
    TenantStatus,
    is_super_admin_email,
    new_tenant,
    normalize_slug,
)

configure()
log = logging.getLogger("backend")


@asynccontextmanager
async def lifespan(app):
    client, db = database()
    redis = Redis.from_url(settings.redis_url, decode_responses=True)
    app.state.db, app.state.redis = db, redis
    try:
        await initialize(db)
        watcher = asyncio.create_task(watch_gateway_logins(app))
        try:
            yield
        finally:
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)
    finally:
        await redis.aclose()
        await client.close()


async def watch_gateway_logins(app):
    """Poll every managed gateway's IBC logs for login and two-factor progress.

    One loop covers every tenant. Each connection's snapshot is stored under its
    own short-lived key and announced on its own tenant's stream, so a phase
    change reaches the right dashboard without waiting for the 15s REST refresh.
    A cross-process lock keeps two API replicas from polling the same connection.
    """
    interval = max(1.0, settings.gateway_login_poll_seconds)
    ttl = max(15, int(interval * 4))
    redis, db = app.state.redis, app.state.db
    while True:
        try:
            for doc in await registry.supervised(db):
                if doc.get("provider") != registry.Provider.IBKR_GATEWAY.value:
                    continue
                tenant_id, connection_id = doc["tenant_id"], doc["_id"]
                repo = StateRepository(redis, tenant_id, connection_id)
                lock = repo.keys.login_poll(connection_id)
                if not await redis.set(lock, "1", nx=True, px=max(50, int(interval * 1000))):
                    continue
                stored = await repo.login_snapshot(connection_id)
                previous = stored.get("login_phase") if stored else None
                login = await gateway_login.snapshot(doc)
                await repo.set_login(connection_id, login, ttl=ttl)
                if login["login_phase"] != previous:
                    log.info(
                        "gateway.login_phase connection=%s phase=%s previous=%s",
                        connection_id,
                        login["login_phase"],
                        previous,
                    )
                    await repo.stream_gateway(connection_id, await repo.gateway(connection_id))
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("gateway.login_poll_failed")
        await asyncio.sleep(interval)


app = FastAPI(title="IBKR Admin RMS — multi-tenant", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "X-Tenant"],
)


def ok(data):
    return {"success": True, "data": data}


@app.exception_handler(HTTPException)
async def http_error(request, exc):
    return JSONResponse({"success": False, "error": exc.detail}, status_code=exc.status_code)


@app.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    return JSONResponse({"success": False, "error": "Invalid request"}, status_code=422)


@app.exception_handler(Exception)
async def error(request, exc):
    log.exception("api.request_failed", exc_info=exc)
    return JSONResponse({"success": False, "error": "Service unavailable"}, status_code=503)


@app.middleware("http")
async def headers(request, call_next):
    if request.method in ("POST", "DELETE") and request.headers.get("origin") not in settings.origins:
        return JSONResponse({"success": False, "error": "Untrusted origin"}, status_code=403)
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response


def repository(request: Request, user: Principal) -> StateRepository:
    return StateRepository(request.app.state.redis, user.tenant_id)


# ── Session ───────────────────────────────────────────────────────────────────


class Login(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=1024)
    tenant: str | None = Field(default=None, max_length=64)


@app.post("/api/v1/auth/login")
async def login(body: Login, request: Request):
    redis, db = request.app.state.redis, request.app.state.db
    key = f"login:{digest(body.email.lower())}"
    attempts = await redis.incr(key)
    if attempts == 1:
        await redis.expire(key, 900)
    if attempts > 5:
        raise HTTPException(429, "Too many login attempts")
    user = await db.users.find_one({"email": body.email.lower()})
    valid = await asyncio.to_thread(
        passwords.verify, body.password, user["password_hash"] if user else DUMMY_HASH
    )
    if not user or not valid:
        raise HTTPException(401, "Invalid email or password")
    token = random_secrets.token_urlsafe(32)
    await redis.set(f"session:{digest(token)}", user["_id"], ex=settings.session_seconds)
    await redis.delete(key)
    principal = await identity(redis, db, token, body.tenant)
    await db.audit_logs.insert_one(
        {
            "_id": str(uuid4()),
            "tenant_id": principal.active.tenant_id if principal.active else None,
            "user_id": user["_id"],
            "action": "login",
            "timestamp": now(),
        }
    )
    response = JSONResponse(ok(principal.as_dict()))
    cookie = {
        "httponly": True,
        "secure": settings.cookie_secure,
        "samesite": "strict",
        "max_age": settings.session_seconds,
    }
    response.set_cookie(COOKIE, token, **cookie)
    if principal.active:
        # Readable by the browser so the tenant switcher can show the current
        # choice without a round trip; it carries no authority of its own.
        response.set_cookie(TENANT_COOKIE, principal.active.tenant_id, **{**cookie, "httponly": False})
    return response


@app.get("/api/v1/auth/me")
async def me(user: Principal = Depends(require_user)):
    return ok(user.as_dict())


@app.post("/api/v1/auth/logout")
async def logout(request: Request):
    await request.app.state.redis.delete(f"session:{digest(request.cookies.get(COOKIE, ''))}")
    response = JSONResponse(ok(None))
    response.delete_cookie(COOKIE)
    response.delete_cookie(TENANT_COOKIE)
    return response


@app.get("/health")
async def health(request: Request):
    await request.app.state.redis.ping()
    await request.app.state.db.command("ping")
    return ok({"status": "ok", "mongodb": "connected", "redis": "connected"})


# ── Tenants ───────────────────────────────────────────────────────────────────


class TenantSwitch(BaseModel):
    tenant: str = Field(min_length=1, max_length=64)


@app.get("/api/v1/tenants")
async def my_tenants(request: Request, user: Principal = Depends(require_user)):
    """Tenants this login may act inside. A super admin sees every one."""
    if user.is_super_admin:
        rows = [doc async for doc in request.app.state.db.tenants.find().sort("name", 1)]
        mine = {m.tenant_id for m in user.memberships}
        return ok(
            {
                "active": user.active.as_dict() if user.active else None,
                "tenants": [
                    {
                        "tenant_id": doc["_id"],
                        "slug": doc["slug"],
                        "name": doc["name"],
                        "status": doc.get("status", TenantStatus.ACTIVE.value),
                        "role": next(
                            (m.role.value for m in user.memberships if m.tenant_id == doc["_id"]),
                            TenantRole.OWNER.value,
                        ),
                        "member": doc["_id"] in mine,
                    }
                    for doc in rows
                ],
            }
        )
    return ok(
        {
            "active": user.active.as_dict() if user.active else None,
            "tenants": [{**m.as_dict(), "member": True} for m in user.memberships],
        }
    )


@app.post("/api/v1/tenants/switch")
async def switch_tenant(body: TenantSwitch, request: Request, user: Principal = Depends(require_user)):
    """Change the active tenant for this browser session."""
    principal = await identity(
        request.app.state.redis,
        request.app.state.db,
        request.cookies.get(COOKIE),
        body.tenant,
    )
    if principal.active is None:
        raise HTTPException(404, "Tenant not found")
    response = JSONResponse(ok(principal.as_dict()))
    response.set_cookie(
        TENANT_COOKIE,
        principal.active.tenant_id,
        httponly=False,
        secure=settings.cookie_secure,
        samesite="strict",
        max_age=settings.session_seconds,
    )
    return response


class TenantCreate(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    slug: str | None = Field(default=None, max_length=40)
    owner_email: str | None = Field(default=None, max_length=254)


class TenantUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=80)
    status: Literal["ACTIVE", "SUSPENDED"] | None = None


def tenant_row(doc: dict) -> dict:
    return {
        "tenant_id": doc["_id"],
        "slug": doc["slug"],
        "name": doc["name"],
        "status": doc.get("status", TenantStatus.ACTIVE.value),
        "created_at": doc.get("created_at"),
        "features": doc.get("features", {}),
    }


@app.get("/api/v1/admin/tenants")
async def list_tenants(request: Request, user: Principal = Depends(require_super_admin)):
    db = request.app.state.db
    rows = [doc async for doc in db.tenants.find().sort("name", 1)]
    counts = {}
    for doc in rows:
        counts[doc["_id"]] = {
            "members": await db.tenant_members.count_documents(
                {"tenant_id": doc["_id"], "status": "ACTIVE"}
            ),
            "connections": await db.broker_connections.count_documents({"tenant_id": doc["_id"]}),
            "accounts": await db.ibkr_accounts.count_documents({"tenant_id": doc["_id"]}),
        }
    return ok([{**tenant_row(doc), **counts[doc["_id"]]} for doc in rows])


@app.post("/api/v1/admin/tenants")
async def create_tenant(body: TenantCreate, request: Request, user: Principal = Depends(require_super_admin)):
    """Onboard a client as a new tenant.

    Optionally attaches an existing login as its OWNER, which is how a client
    administrator gets in without a second account.
    """
    db = request.app.state.db
    slug = normalize_slug(body.slug or body.name)
    if await db.tenants.find_one({"slug": slug}):
        raise HTTPException(409, f"A tenant with the slug '{slug}' already exists")
    tenant = new_tenant(body.name, slug)
    await db.tenants.insert_one(tenant)
    owner = None
    if body.owner_email:
        owner = await db.users.find_one({"email": body.owner_email.lower()})
        if not owner:
            raise HTTPException(404, f"No user with the email {body.owner_email}")
        await db.tenant_members.insert_one(
            {
                "_id": str(uuid4()),
                "tenant_id": tenant["_id"],
                "user_id": owner["_id"],
                "role": TenantRole.OWNER.value,
                "accounts": [],
                "status": "ACTIVE",
                "created_at": now(),
            }
        )
    await audit(db, user, "tenant_created", {"tenant": tenant["_id"], "slug": slug})
    return ok({**tenant_row(tenant), "owner": owner["email"] if owner else None})


@app.post("/api/v1/admin/tenants/{tenant_id}")
async def update_tenant(
    tenant_id: str, body: TenantUpdate, request: Request, user: Principal = Depends(require_super_admin)
):
    db = request.app.state.db
    changes = {k: v for k, v in body.model_dump(exclude_none=True).items()}
    if not changes:
        raise HTTPException(422, "Provide a name or status to change")
    changes["updated_at"] = now()
    result = await db.tenants.update_one({"_id": tenant_id}, {"$set": changes})
    if not result.matched_count:
        raise HTTPException(404, "Tenant not found")
    await audit(db, user, "tenant_updated", {"tenant": tenant_id, **changes})
    return ok(tenant_row(await db.tenants.find_one({"_id": tenant_id})))


# ── Members ───────────────────────────────────────────────────────────────────


class MemberUpsert(BaseModel):
    email: str = Field(max_length=254)
    role: Literal["OWNER", "ADMIN", "TRADER", "VIEWER"] = "VIEWER"
    accounts: list[str] = Field(default_factory=list, max_length=200)


@app.get("/api/v1/members")
async def list_members(request: Request, user: Principal = Depends(require_tenant_admin)):
    db = request.app.state.db
    rows = [doc async for doc in db.tenant_members.find(user.scope({"status": "ACTIVE"}))]
    users = {
        doc["_id"]: doc
        async for doc in db.users.find({"_id": {"$in": [row["user_id"] for row in rows]}})
    }
    return ok(
        [
            {
                "user_id": row["user_id"],
                "email": users.get(row["user_id"], {}).get("email", "unknown"),
                "role": row.get("role", TenantRole.VIEWER.value),
                "accounts": row.get("accounts", []),
                "is_super_admin": is_super_admin_email(users.get(row["user_id"], {}).get("email", "")),
            }
            for row in rows
        ]
    )


@app.post("/api/v1/members")
async def upsert_member(
    body: MemberUpsert, request: Request, user: Principal = Depends(require_tenant_admin)
):
    """Grant or change a login's access inside the active tenant.

    The login must already exist; this endpoint deliberately cannot create one,
    so nobody can mint credentials for an address they do not control.
    """
    db = request.app.state.db
    member = await db.users.find_one({"email": body.email.lower()})
    if not member:
        raise HTTPException(
            404, f"No user with the email {body.email}. Create the login first with `python -m app.auth`."
        )
    await db.tenant_members.update_one(
        user.scope({"user_id": member["_id"]}),
        {
            "$set": {"role": body.role, "accounts": body.accounts, "status": "ACTIVE", "updated_at": now()},
            "$setOnInsert": {
                "_id": str(uuid4()),
                "tenant_id": user.tenant_id,
                "user_id": member["_id"],
                "created_at": now(),
            },
        },
        upsert=True,
    )
    await audit(db, user, "member_upserted", {"email": body.email.lower(), "role": body.role})
    return ok({"email": body.email.lower(), "role": body.role, "accounts": body.accounts})


@app.delete("/api/v1/members/{user_id}")
async def remove_member(user_id: str, request: Request, user: Principal = Depends(require_tenant_admin)):
    db = request.app.state.db
    if user_id == user.id:
        raise HTTPException(409, "You cannot remove your own access to this tenant")
    result = await db.tenant_members.update_one(
        user.scope({"user_id": user_id}), {"$set": {"status": "ARCHIVED", "updated_at": now()}}
    )
    if not result.matched_count:
        raise HTTPException(404, "Member not found in this tenant")
    await audit(db, user, "member_removed", {"user_id": user_id})
    return ok({"removed": user_id})


# ── Broker connections ────────────────────────────────────────────────────────


class ConnectionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    provider: Literal["ibkr_gateway", "snaptrade"] = "ibkr_gateway"
    trading_mode: Literal["live", "paper"] = "paper"
    account_filter: str = Field(default="", max_length=32)
    #: Read-only logins skip IBKR's second factor entirely, which is what makes
    #: an unattended start possible. This platform never places orders.
    read_only_login: bool = True
    second_factor_device: str = Field(default="", max_length=64)


class ConnectionUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    status: Literal["DRAFT", "ENABLED", "DISABLED"] | None = None
    trading_mode: Literal["live", "paper"] | None = None
    account_filter: str | None = Field(default=None, max_length=32)
    read_only_login: bool | None = None
    second_factor_device: str | None = Field(default=None, max_length=64)
    host: str | None = Field(default=None, max_length=253, pattern=r"^[A-Za-z0-9._-]+$")
    client_id: int | None = Field(default=None, gt=0, lt=1000000)


@app.get("/api/v1/connections")
async def list_connections(request: Request, user: Principal = Depends(require_tenant)):
    user.require_tenant_admin()
    db, redis = request.app.state.db, request.app.state.redis
    rows = []
    for doc in await registry.list_for(db, user.tenant_id):
        row = registry.present(doc)
        repo = StateRepository(redis, user.tenant_id, doc["_id"])
        row["state"] = await repo.gateway(doc["_id"])
        rows.append(row)
    return ok(rows)


@app.post("/api/v1/connections")
async def create_connection(
    body: ConnectionCreate, request: Request, user: Principal = Depends(require_tenant_admin)
):
    """Register a broker connection for this tenant, and provision what it needs.

    For `ibkr_gateway` that means allocating a free API port and client id,
    writing the instance's own IBC config and launcher, and installing the
    templated systemd unit — everything short of the IBKR login itself, which
    arrives separately so credentials never ride along with configuration.
    """
    db = request.app.state.db
    if await db.broker_connections.find_one(user.scope({"name": body.name.strip()})):
        raise HTTPException(409, f"This tenant already has a connection named '{body.name}'")

    provider = registry.Provider(body.provider)
    doc = registry.new_connection(
        user.tenant_id,
        body.name,
        provider,
        created_by=user.id,
        trading_mode=body.trading_mode,
        account_filter=body.account_filter,
        read_only_login=body.read_only_login,
        second_factor_device=body.second_factor_device or None,
    )

    if provider is registry.Provider.IBKR_GATEWAY:
        doc["host"] = "127.0.0.1"
        doc["api_port"] = await registry.allocate_port(db, user.tenant_id)
        doc["client_id"] = await registry.allocate_client_id(db, user.tenant_id)
        layout = await asyncio.to_thread(provisioning.provision_files, doc)
        doc.update(
            {
                "ibc_config_path": layout["ibc_config_path"],
                "ibc_log_directory": layout["ibc_log_directory"],
                "service_unit": layout["service_unit"],
                "launcher_path": layout["launcher_path"],
            }
        )
        await asyncio.to_thread(provisioning.write_unit_template)
        await hostctl.daemon_reload()
    else:
        snaptrade.require_configured()
        if not secrets.available():
            raise HTTPException(
                503, "SECRET_KEY is not configured; SnapTrade user secrets cannot be stored"
            )
        doc["snaptrade_user_id"] = f"{user.tenant_id}:{doc['_id']}"
        async with snaptrade.SnapTradeClient() as client:
            registered = await client.register_user(doc["snaptrade_user_id"])
        doc["snaptrade_user_secret"] = secrets.encrypt(str(registered["userSecret"]))

    await db.broker_connections.insert_one(doc)
    await audit(db, user, "connection_created", {"connection": doc["_id"], "provider": body.provider})
    return ok(registry.present(doc))


@app.post("/api/v1/connections/{connection_id}")
async def update_connection(
    connection_id: str,
    body: ConnectionUpdate,
    request: Request,
    user: Principal = Depends(require_tenant_admin),
):
    db = request.app.state.db
    doc = await registry.by_id(db, user.tenant_id, connection_id)
    changes = body.model_dump(exclude_none=True)
    if not changes:
        raise HTTPException(422, "Provide at least one field to change")
    if changes.get("status") == registry.ConnectionStatus.ENABLED.value:
        if doc["provider"] == registry.Provider.IBKR_GATEWAY.value and not doc.get("api_port"):
            raise HTTPException(409, "This connection has no API port; provision it before enabling")
    merged = {**doc, **changes}
    # A change to how the gateway logs in has to reach its config file, or the
    # dashboard would report a setting the running instance never received.
    rewrite = doc.get("managed", True) and doc["provider"] == registry.Provider.IBKR_GATEWAY.value
    if rewrite and {"trading_mode", "read_only_login", "second_factor_device"} & set(changes):
        await asyncio.to_thread(provisioning.provision_files, merged)
    changes["updated_at"] = now()
    await db.broker_connections.update_one({"_id": connection_id, "tenant_id": user.tenant_id}, {"$set": changes})
    await audit(db, user, "connection_updated", {"connection": connection_id, **changes})
    return ok(registry.present({**doc, **changes}))


@app.delete("/api/v1/connections/{connection_id}")
async def delete_connection(
    connection_id: str, request: Request, user: Principal = Depends(require_tenant_admin)
):
    """Remove a connection, stopping and deleting anything provisioned for it."""
    db = request.app.state.db
    doc = await registry.by_id(db, user.tenant_id, connection_id)
    if doc["provider"] == registry.Provider.IBKR_GATEWAY.value and doc.get("managed", True):
        try:
            await hostctl.process_action("stop", registry.unit_for(doc))
        except (RuntimeError, ValueError, OSError):
            log.warning("connection.stop_failed connection=%s", connection_id)
        await asyncio.to_thread(provisioning.remove_files, doc)
    await db.broker_connections.delete_one({"_id": connection_id, "tenant_id": user.tenant_id})
    redis = request.app.state.redis
    keys = StateRepository(redis, user.tenant_id, connection_id).keys
    await redis.delete(
        keys.gateway(connection_id),
        keys.login(connection_id),
        keys.target(connection_id),
        keys.connection_accounts(connection_id),
    )
    await audit(db, user, "connection_deleted", {"connection": connection_id})
    return ok({"deleted": connection_id})


async def guarded_command(request: Request, user: Principal, connection_id: str, action: str, payload: dict):
    """Rate-limit and audit one operator command against one connection."""
    if action not in {"process_start", "process_stop", "process_restart", "reconnect"} or not user.can_control_gateway:
        user.require_tenant_admin()
    redis = request.app.state.redis
    keys = StateRepository(redis, user.tenant_id, connection_id).keys
    if not await redis.set(keys.command_lock(connection_id, action), user.id, nx=True, ex=5):
        raise HTTPException(429, "A command was just issued; wait a moment and retry")
    await audit(request.app.state.db, user, f"gateway_{action}", {"connection": connection_id, **payload})
    log.info("gateway.%s_requested connection=%s by=%s", action, connection_id, user.email)


class GatewayCredentials(BaseModel):
    username: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._-]+$")
    password: str = Field(min_length=1, max_length=256)
    mode: Literal["live", "paper"]
    port: int = Field(gt=0, lt=65536)


class GatewayProcess(BaseModel):
    action: Literal["start", "stop", "restart"]
    force: bool = False


class GatewayTarget(BaseModel):
    host: str = Field(min_length=1, max_length=253, pattern=r"^[A-Za-z0-9._-]+$")
    port: int = Field(gt=0, lt=65536)
    client_id: int = Field(gt=0, lt=1000000)


async def gateway_connection(db, user: Principal, connection_id: str | None) -> dict:
    """The connection a gateway command targets, defaulting to the tenant's primary."""
    if connection_id:
        return await registry.by_id(db, user.tenant_id, connection_id)
    doc = await registry.primary(db, user.tenant_id)
    if not doc:
        raise HTTPException(404, "This tenant has no broker connection yet")
    return doc


@app.post("/api/v1/connections/{connection_id}/credentials")
async def connection_credentials(
    connection_id: str,
    body: GatewayCredentials,
    request: Request,
    user: Principal = Depends(require_tenant_admin),
):
    """Write an IBKR login into this connection's own IBC config.

    The password goes to that file at 0600 and nowhere else — not MongoDB, not
    this API's responses, not the logs.
    """
    db = request.app.state.db
    doc = await registry.by_id(db, user.tenant_id, connection_id)
    if doc["provider"] != registry.Provider.IBKR_GATEWAY.value:
        raise HTTPException(409, "Only IB Gateway connections take IBKR credentials")
    config_path = doc.get("ibc_config_path")
    if not config_path:
        raise HTTPException(409, "This connection has not been provisioned yet")
    await guarded_command(
        request, user, connection_id, "credentials", {"username": body.username, "mode": body.mode}
    )
    try:
        await asyncio.to_thread(
            hostctl.write_credentials,
            config_path,
            body.username,
            body.password,
            body.mode,
            body.port,
            read_only_login=doc.get("read_only_login", True),
            second_factor_device=doc.get("second_factor_device"),
        )
    except OSError as exc:
        raise HTTPException(503, f"Could not write the IB Gateway configuration: {exc}") from exc
    await db.broker_connections.update_one(
        {"_id": connection_id, "tenant_id": user.tenant_id},
        {
            "$set": {
                "ibkr_username": body.username,
                "trading_mode": body.mode,
                "api_port": body.port,
                "updated_at": now(),
            }
        },
    )
    return ok({"username": body.username, "mode": body.mode, "port": body.port})


@app.post("/api/v1/connections/{connection_id}/process")
async def connection_process(
    connection_id: str,
    body: GatewayProcess,
    request: Request,
    user: Principal = Depends(require_gateway_operator),
):
    """Start, stop, or restart this connection's IB Gateway.

    Stopping or restarting is refused while an IBKR push is still outstanding —
    it would cancel a request the operator may be seconds from approving. Resend
    with `force` to override; the audit record keeps the flag.
    """
    db = request.app.state.db
    doc = await registry.by_id(db, user.tenant_id, connection_id)
    if doc["provider"] != registry.Provider.IBKR_GATEWAY.value:
        raise HTTPException(409, "Only IB Gateway connections have a managed process")
    if body.action in ("stop", "restart") and not body.force:
        login = await gateway_login.snapshot(doc)
        if gateway_login.restart_blocked(login):
            raise HTTPException(
                409,
                f"A two-factor request is still open with "
                f"{login['two_factor_remaining_seconds']}s left. Approve it in IBKR Mobile, "
                f"or repeat this command with force to cancel the request.",
            )
    await guarded_command(
        request, user, connection_id, f"process_{body.action}", {"action": body.action, "force": body.force}
    )
    try:
        state = await hostctl.process_action(body.action, registry.unit_for(doc))
    except (RuntimeError, ValueError, OSError) as exc:
        raise HTTPException(503, f"IB Gateway {body.action} failed: {exc}") from exc
    await StateRepository(request.app.state.redis, user.tenant_id).clear_login(connection_id)
    return ok({"action": body.action, "process": state})


@app.post("/api/v1/connections/{connection_id}/target")
async def connection_target(
    connection_id: str,
    body: GatewayTarget,
    request: Request,
    user: Principal = Depends(require_tenant_admin),
):
    """Override where the worker connects for this connection, then reconnect."""
    db = request.app.state.db
    await registry.by_id(db, user.tenant_id, connection_id)
    payload = body.model_dump()
    await guarded_command(request, user, connection_id, "target", payload)
    repo = StateRepository(request.app.state.redis, user.tenant_id)
    await repo.set_target(connection_id, payload)
    await request.app.state.redis.publish(
        COMMAND_CHANNEL,
        json.dumps({"command": "reconnect", "tenant_id": user.tenant_id, "connection_id": connection_id}),
    )
    return ok(payload)


@app.post("/api/v1/connections/{connection_id}/reconnect")
async def connection_reconnect(
    connection_id: str, request: Request, user: Principal = Depends(require_gateway_operator)
):
    db = request.app.state.db
    await registry.by_id(db, user.tenant_id, connection_id)
    await guarded_command(request, user, connection_id, "reconnect", {})
    await request.app.state.redis.publish(
        COMMAND_CHANNEL,
        json.dumps({"command": "reconnect", "tenant_id": user.tenant_id, "connection_id": connection_id}),
    )
    return ok({"requested": True})


@app.post("/api/v1/connections/{connection_id}/snaptrade/link")
async def snaptrade_link(
    connection_id: str, request: Request, user: Principal = Depends(require_tenant_admin)
):
    """A one-time hosted-consent URL for the client to link their brokerage.

    This is the whole point of the SnapTrade path: the client authorises their
    own broker on IBKR's and SnapTrade's screens, and no IBKR password ever
    reaches this platform or its operator.
    """
    db = request.app.state.db
    doc = await registry.by_id(db, user.tenant_id, connection_id)
    if doc["provider"] != registry.Provider.SNAPTRADE.value:
        raise HTTPException(409, "This is not a SnapTrade connection")
    secret = doc.get("snaptrade_user_secret")
    if not secret:
        raise HTTPException(409, "This SnapTrade connection has not been registered yet")
    async with snaptrade.SnapTradeClient(doc["snaptrade_user_id"], secrets.decrypt(secret)) as client:
        url = await client.login_link()
    await audit(db, user, "snaptrade_link_issued", {"connection": connection_id})
    return ok({"url": url})


@app.get("/api/v1/connections/{connection_id}/snaptrade/status")
async def snaptrade_status(
    connection_id: str, request: Request, user: Principal = Depends(require_tenant_admin)
):
    db = request.app.state.db
    doc = await registry.by_id(db, user.tenant_id, connection_id)
    if doc["provider"] != registry.Provider.SNAPTRADE.value:
        raise HTTPException(409, "This is not a SnapTrade connection")
    secret = doc.get("snaptrade_user_secret")
    if not secret:
        raise HTTPException(409, "This SnapTrade connection has not been registered yet")
    async with snaptrade.SnapTradeClient(doc["snaptrade_user_id"], secrets.decrypt(secret)) as client:
        authorizations = await client.authorizations()
    linked = [
        {
            "id": row.get("id"),
            "brokerage": (row.get("brokerage") or {}).get("name"),
            "disabled": bool(row.get("disabled")),
        }
        for row in authorizations
    ]
    await db.broker_connections.update_one(
        {"_id": connection_id, "tenant_id": user.tenant_id},
        {"$set": {"snaptrade_authorized": bool(linked), "snaptrade_authorization_ids": [
            str(row["id"]) for row in linked if row.get("id")
        ]}},
    )
    return ok({"authorizations": linked})


# ── Gateway (the active tenant's primary connection) ──────────────────────────


@app.get("/api/v1/gateway")
@app.get("/api/v1/gateway/status")
async def gateway(request: Request, connection_id: str | None = None, user: Principal = Depends(require_tenant)):
    db = request.app.state.db
    doc = await registry.primary(db, user.tenant_id) if not connection_id else None
    if connection_id:
        doc = await registry.by_id(db, user.tenant_id, connection_id)
    if not doc:
        return ok({"status": "DISCONNECTED", "connection_id": None, "configured": False})
    repo = StateRepository(request.app.state.redis, user.tenant_id, doc["_id"])
    state = await repo.gateway(doc["_id"])
    state["configured"] = True
    state["connection_name"] = doc.get("name")
    state["provider"] = doc.get("provider")
    if not user.can_control_gateway:
        # Traders see liveness, not host configuration or login progress.
        return ok(
            {
                key: state.get(key)
                for key in (
                    "status",
                    "last_heartbeat",
                    "connected_at",
                    "reconnect_attempts",
                    "connection_id",
                    "connection_name",
                    "provider",
                    "configured",
                )
            }
        )
    if doc.get("provider") == registry.Provider.IBKR_GATEWAY.value:
        state.update(await gateway_login.snapshot(doc))
    state["managed"] = doc.get("managed", True)
    state["service_unit"] = registry.unit_for(doc)
    return ok(state)


# ── Gateway aliases for the tenant's primary connection ───────────────────────
#
# A tenant with one gateway — the common case — should not have to name its id
# on every call. These resolve the primary connection and delegate, so the same
# handler, guard rails, and audit trail cover both surfaces.


@app.post("/api/v1/gateway/credentials")
async def primary_credentials(
    body: GatewayCredentials, request: Request, user: Principal = Depends(require_tenant_admin)
):
    doc = await gateway_connection(request.app.state.db, user, None)
    return await connection_credentials(doc["_id"], body, request, user)


@app.post("/api/v1/gateway/process")
async def primary_process(
    body: GatewayProcess, request: Request, user: Principal = Depends(require_gateway_operator)
):
    doc = await gateway_connection(request.app.state.db, user, None)
    return await connection_process(doc["_id"], body, request, user)


@app.post("/api/v1/gateway/target")
async def primary_target(
    body: GatewayTarget, request: Request, user: Principal = Depends(require_tenant_admin)
):
    doc = await gateway_connection(request.app.state.db, user, None)
    return await connection_target(doc["_id"], body, request, user)


@app.post("/api/v1/gateway/reconnect")
async def primary_reconnect(request: Request, user: Principal = Depends(require_gateway_operator)):
    doc = await gateway_connection(request.app.state.db, user, None)
    return await connection_reconnect(doc["_id"], request, user)


# ── Accounts ──────────────────────────────────────────────────────────────────


@app.get("/api/v1/accounts")
async def accounts(request: Request, user: Principal = Depends(require_tenant)):
    repo = repository(request, user)
    ids = await repo.accounts()
    return ok([await summary_data(repo, account) for account in sorted(ids) if user.sees(account)])


async def summary_data(repo: StateRepository, account: str):
    data = await repo.account(account)
    if data is None or not await repo.knows_account(account):
        raise HTTPException(404, "Account not found")
    return {
        **data,
        "open_positions": len(await repo.rows(account, "positions")),
        "open_orders": len(await repo.rows(account, "orders")),
    }


@app.get("/api/v1/accounts/{account_id}")
@app.get("/api/v1/accounts/{account_id}/summary")
async def summary(account_id: str, request: Request, user: Principal = Depends(require_tenant)):
    user.require_account(account_id)
    return ok(await summary_data(repository(request, user), account_id))


@app.get("/api/v1/accounts/{account_id}/positions")
@app.get("/api/v1/accounts/{account_id}/orders")
@app.get("/api/v1/accounts/{account_id}/executions")
async def rows(account_id: str, request: Request, limit: int = 100, user: Principal = Depends(require_tenant)):
    user.require_account(account_id)
    repo = repository(request, user)
    if not await repo.knows_account(account_id):
        raise HTTPException(404, "Account not found")
    kind = request.url.path.rsplit("/", 1)[-1]
    if kind == "executions":
        cursor = request.app.state.db.executions.find(
            user.scope({"account_id": account_id}), {"_id": 0, "tenant_id": 0}
        )
        return ok(await cursor.sort("executed_at", -1).limit(max(1, min(limit, 500))).to_list())
    return ok(await repo.rows(account_id, kind))


# ── Diagnostics ───────────────────────────────────────────────────────────────


@app.get("/api/v1/admin/diagnostics")
async def diagnostics(request: Request, user: Principal = Depends(require_tenant_admin)):
    redis, db = request.app.state.redis, request.app.state.db
    repo = repository(request, user)
    ids = await repo.accounts()
    entries = await redis.xrevrange(repo.keys.events, count=100)
    primary = await registry.primary(db, user.tenant_id)
    return ok(
        {
            "gateway": await repo.gateway(primary["_id"]) if primary else {"status": "DISCONNECTED"},
            "connections": [registry.present(doc) for doc in await registry.list_for(db, user.tenant_id)],
            "last_events": {a: await redis.hgetall(repo.keys.diagnostics(a)) for a in sorted(ids)},
            "events": [json.loads(e["event"]) for _, e in entries],
            "visibility_tests": await db.visibility_tests.find(
                user.scope(), {"_id": 0, "tenant_id": 0}
            ).sort("checked_at", -1).to_list(100),
        }
    )


class VisibilityTest(BaseModel):
    account_id: str
    perm_id: int = Field(gt=0)
    execution_id: str | None = None
    expected_working_perm_ids: list[int] = Field(default_factory=list, max_length=1000)
    started_at: AwareDatetime


@app.post("/api/v1/admin/diagnostics/visibility")
async def visibility(body: VisibilityTest, request: Request, user: Principal = Depends(require_tenant_admin)):
    started_at = body.started_at.astimezone(UTC).isoformat()
    elapsed = (now() - body.started_at).total_seconds()
    if elapsed < 0 or elapsed > 3600:
        raise HTTPException(422, "Observation window must start within the last hour")
    db, redis = request.app.state.db, request.app.state.redis
    repo = repository(request, user)
    primary = await registry.primary(db, user.tenant_id)
    if not primary:
        raise HTTPException(409, "This tenant has no broker connection yet")
    gateway_state = await repo.gateway(primary["_id"])
    if gateway_state["status"] != "CONNECTED":
        raise HTTPException(409, "A healthy live connection is required")
    order = await db.orders.find_one(user.scope({"account_id": body.account_id, "perm_id": body.perm_id}))
    execution = (
        await db.executions.find_one(
            user.scope(
                {
                    "execution_id": body.execution_id,
                    "account_id": body.account_id,
                    "perm_id": body.perm_id,
                }
            )
        )
        if body.execution_id
        else None
    )
    entries = await redis.xrange(
        repo.keys.events, min=f"{int(body.started_at.timestamp() * 1000)}-0", count=10001
    )
    if len(entries) > 10000:
        raise HTTPException(409, "Observation window too large; begin a shorter test")
    events = [json.loads(fields["event"]) for _, fields in entries]
    order_seen = any(
        e["account_id"] == body.account_id
        and e["event_type"].startswith("order.")
        and e["data"].get("perm_id") == body.perm_id
        for e in events
    )
    position_seen = bool(execution) and any(
        e["account_id"] == body.account_id
        and e["event_type"].startswith("position.")
        and e["data"].get("con_id") == execution["con_id"]
        and e["data"].get("quantity_changed", False)
        for e in events
    )
    execution_seen = bool(execution) and any(
        e["event_type"] == "execution.created"
        and e["data"].get("execution_id") == body.execution_id
        and datetime.fromisoformat(e["data"]["executed_at"]) >= body.started_at
        for e in events
    )
    order_status_seen = any(
        e["account_id"] == body.account_id
        and e["event_type"].startswith("order.")
        and e["data"].get("perm_id") == body.perm_id
        and e["data"].get("status") in ("Filled", "Submitted")
        and Decimal(e["data"].get("filled_quantity", "0")) > 0
        for e in events
    )
    working = await repo.rows(body.account_id, "orders")
    seen = {row["perm_id"] for row in working}
    result = {
        **body.model_dump(mode="json"),
        "tenant_id": user.tenant_id,
        "connection_id": primary["_id"],
        "started_at": started_at,
        "checked_at": now().isoformat(),
        "external_order_visibility": "PASS" if order and order_seen else "FAIL",
        "external_execution_visibility": (
            "PASS" if execution_seen and position_seen and order_status_seen else "FAIL"
        )
        if body.execution_id
        else "NOT_TESTED",
        "working_orders_visibility": ("PASS" if set(body.expected_working_perm_ids) <= seen else "FAIL")
        if body.expected_working_perm_ids
        else "NOT_TESTED",
        "missing_working_perm_ids": sorted(set(body.expected_working_perm_ids) - seen),
        "evidence": {
            "order_event": order_seen,
            "position_event": position_seen,
            "execution_event": execution_seen,
            "filled_order_status": order_status_seen,
        },
    }
    await db.visibility_tests.insert_one(dict(result))
    await audit(db, user, "visibility_test", result)
    return ok({k: v for k, v in result.items() if k != "tenant_id"})


# ── Live stream ───────────────────────────────────────────────────────────────


@app.websocket("/ws/live")
async def live(ws: WebSocket):
    if ws.headers.get("origin") not in settings.origins:
        await ws.close(code=1008)
        return
    redis, db = ws.app.state.redis, ws.app.state.db
    try:
        user = await identity(redis, db, ws.cookies.get(COOKIE), requested_tenant(ws))
    except HTTPException:
        await ws.close(code=1008)
        return
    if user.active is None:
        await ws.close(code=1008)
        return
    # The stream this socket reads is fixed at the tenant the handshake resolved.
    # Re-resolving identity below can revoke access; it can never widen it to a
    # different tenant's stream.
    tenant_id = user.tenant_id
    stream = user.keys.events
    await ws.accept()
    subscribed = set()
    latest = await redis.xrevrange(stream, count=1)
    cursor = latest[0][0] if latest else "0-0"
    send_lock = asyncio.Lock()

    async def send(data):
        async with send_lock:
            await asyncio.wait_for(ws.send_json(data), timeout=10)

    async def refresh() -> Principal:
        current = await identity(redis, db, ws.cookies.get(COOKIE), tenant_id)
        if current.active is None or current.tenant_id != tenant_id:
            raise HTTPException(403, "Tenant access revoked")
        return current

    async def receive():
        nonlocal subscribed, user
        while True:
            message = await asyncio.wait_for(ws.receive_json(), timeout=45)
            user = await refresh()
            if message.get("type") == "subscribe":
                subscribed = subscriptions(user, message.get("accounts", []))
                await send({"event_type": "subscribed", "accounts": sorted(subscribed)})
            elif message.get("type") == "ping":
                await send({"event_type": "pong"})

    async def stream_events():
        nonlocal cursor, user
        while True:
            batches = await redis.xread({stream: cursor}, count=100, block=1000)
            if batches:
                user = await refresh()
            for _, entries in batches:
                for event_id, fields in entries:
                    cursor = event_id
                    event = json.loads(fields["event"])
                    account = event["account_id"]
                    if event["event_type"].startswith("gateway."):
                        if not subscribed:
                            continue
                        event["event_type"] = "gateway.updated"
                        event["data"] = {
                            **event["data"],
                            "connection_id": fields.get("connection_id"),
                        }
                        if not user.is_tenant_admin:
                            event["data"] = {
                                key: event["data"].get(key)
                                for key in (
                                    "status",
                                    "last_heartbeat",
                                    "connected_at",
                                    "reconnect_attempts",
                                    "connection_id",
                                )
                            }
                    elif not user.sees(account) or not (account in subscribed or "*" in subscribed):
                        continue
                    await send(event)

    tasks = [asyncio.create_task(receive()), asyncio.create_task(stream_events())]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    except (WebSocketDisconnect, TimeoutError):
        log.info("websocket.disconnected")
    except HTTPException:
        log.info("websocket.access_revoked")
    except Exception:
        log.exception("websocket.failed")
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        try:
            await ws.close()
        except (RuntimeError, WebSocketDisconnect):
            log.debug("websocket.already_closed")
