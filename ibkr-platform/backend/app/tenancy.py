from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any
from uuid import uuid4

from fastapi import HTTPException

SUPER_ADMIN_EMAIL = "ekalon.consulting@gmail.com"

def is_super_admin_email(email: str) -> bool:
    return email.strip().lower() == SUPER_ADMIN_EMAIL

SLUG_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$")

TENANT_COLLECTIONS = (
    "tenant_members",
    "broker_connections",
    "ibkr_accounts",
    "account_users",
    "orders",
    "order_events",
    "executions",
    "audit_logs",
    "visibility_tests",
)

class TenantStatus(StrEnum):
    ACTIVE = "ACTIVE"
    SUSPENDED = "SUSPENDED"

class TenantRole(StrEnum):

    OWNER = "OWNER"
    ADMIN = "ADMIN"
    TRADER = "TRADER"
    VIEWER = "VIEWER"

TENANT_ADMIN_ROLES = frozenset({TenantRole.OWNER, TenantRole.ADMIN})
TENANT_ALL_ACCOUNT_ROLES = TENANT_ADMIN_ROLES

def now() -> datetime:
    return datetime.now(UTC)

def normalize_slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (value or "").strip().lower()).strip("-")
    if not SLUG_PATTERN.match(slug):
        raise HTTPException(
            422,
            "Tenant slug must be 3–40 characters of lowercase letters, digits, "
            "and hyphens, starting and ending with a letter or digit",
        )
    return slug

def new_tenant(name: str, slug: str | None = None, **extra: Any) -> dict[str, Any]:
    moment = now()
    return {
        "_id": str(uuid4()),
        "slug": normalize_slug(slug or name),
        "name": name.strip(),
        "status": TenantStatus.ACTIVE.value,
        "created_at": moment,
        "updated_at": moment,
        "features": {},
        **extra,
    }

@dataclass(frozen=True, slots=True)
class TenantKeys:

    tenant_id: str

    @property
    def prefix(self) -> str:
        return f"t:{self.tenant_id}"

    @property
    def events(self) -> str:
        return f"{self.prefix}:events"

    @property
    def accounts(self) -> str:
        return f"{self.prefix}:accounts"

    def account_state(self, account: str) -> str:
        return f"{self.prefix}:account:{account}:state"

    def account_rows(self, account: str, kind: str) -> str:
        return f"{self.prefix}:account:{account}:{kind}"

    def diagnostics(self, account: str) -> str:
        return f"{self.prefix}:diagnostics:{account}"

    def connection(self, connection_id: str) -> str:
        return f"{self.prefix}:c:{connection_id}"

    def gateway(self, connection_id: str) -> str:
        return f"{self.connection(connection_id)}:gateway"

    def lease(self, connection_id: str) -> str:
        return f"{self.connection(connection_id)}:lease"

    def target(self, connection_id: str) -> str:
        return f"{self.connection(connection_id)}:target"

    def login(self, connection_id: str) -> str:
        return f"{self.connection(connection_id)}:login"

    def login_poll(self, connection_id: str) -> str:
        return f"{self.connection(connection_id)}:login:poll"

    def command_lock(self, connection_id: str, action: str) -> str:
        return f"{self.connection(connection_id)}:command:{action}"

    def connection_accounts(self, connection_id: str) -> str:
        return f"{self.connection(connection_id)}:accounts"

    @property
    def consumer_group(self) -> str:
        return "mongo-history-v2"

COMMAND_CHANNEL = "platform.commands"

@dataclass(frozen=True, slots=True)
class Membership:
    tenant_id: str
    slug: str
    name: str
    status: str
    role: TenantRole
    accounts: tuple[str, ...]

    @property
    def is_admin(self) -> bool:
        return self.role in TENANT_ADMIN_ROLES

    @property
    def sees_all_accounts(self) -> bool:
        return self.role in TENANT_ALL_ACCOUNT_ROLES

    def as_dict(self) -> dict[str, Any]:
        return {
            "tenant_id": self.tenant_id,
            "slug": self.slug,
            "name": self.name,
            "status": self.status,
            "role": self.role.value,
            "accounts": list(self.accounts),
        }

@dataclass(frozen=True, slots=True)
class Principal:

    id: str
    email: str
    is_super_admin: bool
    memberships: tuple[Membership, ...]
    active: Membership | None
    impersonating: bool = False

    @property
    def tenant_id(self) -> str:
        if self.active is None:
            raise HTTPException(403, "Select a tenant before using this endpoint")
        return self.active.tenant_id

    @property
    def keys(self) -> TenantKeys:
        return TenantKeys(self.tenant_id)

    @property
    def is_tenant_admin(self) -> bool:
        return self.is_super_admin

    @property
    def can_control_gateway(self) -> bool:
        return self.is_super_admin or bool(self.active and self.active.is_admin)

    @property
    def role(self) -> str:
        return "ADMIN" if self.is_tenant_admin else "TRADER"

    def sees(self, account: str) -> bool:
        if self.is_super_admin or (self.active and self.active.sees_all_accounts):
            return True
        return bool(self.active and account in self.active.accounts)

    def require_account(self, account: str) -> None:
        if not self.sees(account):
            raise HTTPException(403, "Account access denied")

    def require_tenant_admin(self) -> None:
        if not self.is_tenant_admin:
            raise HTTPException(403, "Tenant administrator access required")

    def require_super_admin(self) -> None:
        if not self.is_super_admin:
            raise HTTPException(403, "Platform administrator access required")

    def scope(self, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        return {"tenant_id": self.tenant_id, **(extra or {})}

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "email": self.email,
            "role": self.role,
            "is_super_admin": self.is_super_admin,
            "accounts": list(self.active.accounts) if self.active else [],
            "tenant": self.active.as_dict() if self.active else None,
            "tenants": [m.as_dict() for m in self.memberships],
            "impersonating": self.impersonating,
        }

async def load_tenant(db, tenant_id: str) -> dict[str, Any] | None:
    return await db.tenants.find_one({"_id": tenant_id})

async def load_tenant_by_slug(db, slug: str) -> dict[str, Any] | None:
    return await db.tenants.find_one({"slug": slug})

async def memberships_for(db, user_id: str, *, include_suspended: bool = False) -> list[Membership]:
    rows = [row async for row in db.tenant_members.find({"user_id": user_id, "status": "ACTIVE"})]
    if not rows:
        return []
    tenants = {
        doc["_id"]: doc
        async for doc in db.tenants.find({"_id": {"$in": [row["tenant_id"] for row in rows]}})
    }
    memberships = []
    for row in rows:
        tenant = tenants.get(row["tenant_id"])
        if not tenant:
            continue
        if not include_suspended and tenant.get("status") != TenantStatus.ACTIVE.value:
            continue
        memberships.append(
            Membership(
                tenant_id=tenant["_id"],
                slug=tenant["slug"],
                name=tenant["name"],
                status=tenant.get("status", TenantStatus.ACTIVE.value),
                role=TenantRole(row.get("role", TenantRole.VIEWER.value)),
                accounts=tuple(row.get("accounts") or ()),
            )
        )
    return sorted(memberships, key=lambda m: m.name.lower())

def membership_for_super_admin(tenant: dict[str, Any]) -> Membership:
    return Membership(
        tenant_id=tenant["_id"],
        slug=tenant["slug"],
        name=tenant["name"],
        status=tenant.get("status", TenantStatus.ACTIVE.value),
        role=TenantRole.OWNER,
        accounts=(),
    )

async def resolve_active(
    db,
    user: dict[str, Any],
    memberships: list[Membership],
    requested: str | None,
) -> tuple[Membership | None, bool]:
    is_super = bool(user.get("is_super_admin"))
    by_key = {m.tenant_id: m for m in memberships} | {m.slug: m for m in memberships}

    if requested:
        found = by_key.get(requested)
        if found:
            if found.status != TenantStatus.ACTIVE.value and not is_super:
                raise HTTPException(403, "This tenant is suspended. Contact your administrator.")
            return found, False
        if not is_super:
            raise HTTPException(403, "You are not a member of that tenant")
        tenant = await load_tenant(db, requested) or await load_tenant_by_slug(db, requested)
        if not tenant:
            raise HTTPException(404, "Tenant not found")
        return membership_for_super_admin(tenant), True

    default = user.get("default_tenant_id")
    if default and default in by_key:
        return by_key[default], False
    if memberships:
        return memberships[0], False
    if is_super:
        tenant = await db.tenants.find_one({"status": TenantStatus.ACTIVE.value}, sort=[("name", 1)])
        if tenant:
            return membership_for_super_admin(tenant), True
    return None, False
