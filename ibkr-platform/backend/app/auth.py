"""Sessions, identity, and tenant resolution.

Identity is platform-wide: one login can hold memberships in several tenants.
Authorization is per tenant, resolved on every request from MongoDB rather than
cached in the session, so revoking a membership takes effect immediately —
including on an already-open WebSocket, which re-resolves on each batch.
"""

import asyncio
import getpass
import hashlib
from uuid import uuid4

from fastapi import HTTPException, Request
from pwdlib import PasswordHash

from app.db import database, initialize
from app.tenancy import (
    Principal,
    TenantRole,
    is_super_admin_email,
    memberships_for,
    new_tenant,
    normalize_slug,
    now,
    resolve_active,
)

passwords = PasswordHash.recommended()
DUMMY_HASH = passwords.hash("dummy-password-for-timing")
COOKIE = "ibkr_session"
#: Client-selected active tenant. A cookie so it survives a reload, and a header
#: so a single page can address another tenant without disturbing that choice.
TENANT_COOKIE = "ibkr_tenant"
TENANT_HEADER = "x-tenant"


def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def requested_tenant(request) -> str | None:
    """The tenant this request asks to act inside, if it named one."""
    header = request.headers.get(TENANT_HEADER)
    if header:
        return header.strip() or None
    cookie = request.cookies.get(TENANT_COOKIE)
    return cookie.strip() if cookie else None


async def identity(redis, db, token, tenant: str | None = None) -> Principal:
    if not token:
        raise HTTPException(401, "Authentication required")
    user_id = await redis.get(f"session:{digest(token)}")
    user = await db.users.find_one({"_id": user_id}) if user_id else None
    if not user:
        raise HTTPException(401, "Session expired")
    if user.get("status") == "DISABLED":
        raise HTTPException(403, "This account has been disabled")

    # Stored flags and legacy roles cannot grant platform administration.
    is_super = is_super_admin_email(user["email"])
    user = {**user, "is_super_admin": is_super}
    memberships = await memberships_for(db, user_id)
    active, impersonating = await resolve_active(db, user, memberships, tenant)
    return Principal(
        id=user_id,
        email=user["email"],
        is_super_admin=is_super,
        memberships=tuple(memberships),
        active=active,
        impersonating=impersonating,
    )


async def require_user(request: Request) -> Principal:
    return await identity(
        request.app.state.redis,
        request.app.state.db,
        request.cookies.get(COOKIE),
        requested_tenant(request),
    )


async def require_tenant(request: Request) -> Principal:
    """A caller who has an active tenant. Everything account-scoped needs this."""
    user = await require_user(request)
    if user.active is None:
        raise HTTPException(
            403, "No tenant is available for this account. Ask an administrator for access."
        )
    return user


async def require_tenant_admin(request: Request) -> Principal:
    user = await require_tenant(request)
    user.require_tenant_admin()
    return user


async def require_gateway_operator(request: Request) -> Principal:
    user = await require_tenant(request)
    if not user.can_control_gateway:
        raise HTTPException(403, "Gateway operator access required")
    return user


async def require_super_admin(request: Request) -> Principal:
    user = await require_user(request)
    user.require_super_admin()
    return user


def subscriptions(user: Principal, accounts):
    """Validate a WebSocket subscription request against the caller's grants."""
    if not accounts or len(accounts) > 100 or any(not isinstance(a, str) for a in accounts):
        raise HTTPException(422, "Provide 1–100 account identifiers")
    if accounts == ["*"]:
        if not user.is_tenant_admin:
            raise HTTPException(403, "Account access denied")
        return {"*"}
    for account in accounts:
        user.require_account(account)
    return set(accounts)


async def audit(db, user: Principal, action: str, data: dict | None = None):
    await db.audit_logs.insert_one(
        {
            "_id": str(uuid4()),
            "tenant_id": user.active.tenant_id if user.active else None,
            "user_id": user.id,
            "actor_email": user.email,
            "action": action,
            "data": data or {},
            "impersonated": user.impersonating,
            "timestamp": now(),
        }
    )


async def ensure_tenant(db, slug: str, name: str) -> dict:
    """Get or create a tenant by slug. Used by bootstrap and the CLI."""
    slug = normalize_slug(slug)
    existing = await db.tenants.find_one({"slug": slug})
    if existing:
        return existing
    tenant = new_tenant(name, slug)
    await db.tenants.insert_one(tenant)
    return tenant


async def create_user():
    """Operator CLI: create a login and place it in a tenant.

    Phase 1 has no user-management UI, so this stays the way accounts and
    memberships are created.
    """
    import argparse

    parser = argparse.ArgumentParser(description="Create a platform user and tenant membership")
    parser.add_argument("email")
    parser.add_argument("--tenant", default="saatvik", help="Tenant slug (created if absent)")
    parser.add_argument("--tenant-name", default=None, help="Display name when creating the tenant")
    parser.add_argument(
        "--role",
        choices=[role.value for role in TenantRole],
        default=TenantRole.OWNER.value,
        help="Role within the tenant",
    )
    parser.add_argument(
        "--super-admin",
        action="store_true",
        help="Platform administrator: may act inside every tenant",
    )
    parser.add_argument("--accounts", nargs="*", default=[], help="Account grants for TRADER/VIEWER")
    args = parser.parse_args()

    email = args.email.strip().lower()
    if args.super_admin and not is_super_admin_email(email):
        parser.error("Super admin access is reserved for ekalon.consulting@gmail.com")
    args.super_admin = is_super_admin_email(email)

    password = getpass.getpass("Password (12+ characters): ")
    if len(password) < 12:
        raise SystemExit("Password must have at least 12 characters")

    client, db = database()
    try:
        await initialize(db)
        tenant = await ensure_tenant(db, args.tenant, args.tenant_name or args.tenant.title())
        existing = await db.users.find_one({"email": email})
        if existing:
            user_id = existing["_id"]
            await db.users.update_one(
                {"_id": user_id},
                {"$set": {"password_hash": passwords.hash(password), "is_super_admin": args.super_admin}},
            )
            print(f"Updated existing user {email}")
        else:
            user_id = str(uuid4())
            await db.users.insert_one(
                {
                    "_id": user_id,
                    "email": email,
                    "password_hash": passwords.hash(password),
                    "is_super_admin": args.super_admin,
                    "default_tenant_id": tenant["_id"],
                    "status": "ACTIVE",
                    "created_at": now(),
                }
            )
        await db.tenant_members.update_one(
            {"tenant_id": tenant["_id"], "user_id": user_id},
            {
                "$set": {
                    "role": args.role,
                    "accounts": list(args.accounts),
                    "status": "ACTIVE",
                    "updated_at": now(),
                },
                "$setOnInsert": {
                    "_id": str(uuid4()),
                    "tenant_id": tenant["_id"],
                    "user_id": user_id,
                    "created_at": now(),
                },
            },
            upsert=True,
        )
        print(f"{email} is {args.role} in tenant '{tenant['slug']}'" + (" (super admin)" if args.super_admin else ""))
    finally:
        await client.close()


if __name__ == "__main__":
    asyncio.run(create_user())
