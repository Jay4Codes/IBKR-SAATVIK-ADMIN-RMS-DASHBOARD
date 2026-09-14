from app.auth import COOKIE, TENANT_COOKIE
from tests.conftest import OTHER_TENANT, TENANT, promote_super


def as_user(role):
    return {COOKIE: role}


async def test_only_a_super_admin_lists_or_creates_tenants(client):
    assert (await client.get("/api/v1/admin/tenants", cookies=as_user("TRADER"))).status_code == 403
    response = await client.post(
        "/api/v1/admin/tenants", json={"name": "Acme Capital"}, cookies=as_user("TRADER")
    )
    assert response.status_code == 403


async def test_super_admin_onboards_a_client_as_a_tenant(client, stores):
    _, db = stores
    await promote_super(stores)
    client.cookies.set(COOKIE, "SUPER")
    response = await client.post("/api/v1/admin/tenants", json={"name": "Acme Capital"})
    assert response.status_code == 200
    created = response.json()["data"]
    assert created["slug"] == "acme-capital"
    assert created["status"] == "ACTIVE"
    assert await db.tenants.find_one({"slug": "acme-capital"})

    listed = (await client.get("/api/v1/admin/tenants")).json()["data"]
    assert {row["slug"] for row in listed} >= {"acme-capital", "tenant-one", "tenant-two"}
    acme = next(row for row in listed if row["slug"] == "acme-capital")
    assert acme["members"] == 0 and acme["connections"] == 0


async def test_a_new_tenant_can_take_an_existing_login_as_its_owner(client, stores):
    _, db = stores
    await promote_super(stores)
    client.cookies.set(COOKIE, "SUPER")
    response = await client.post(
        "/api/v1/admin/tenants", json={"name": "Beta Fund", "owner_email": "admin@test.local"}
    )
    assert response.status_code == 200
    tenant = await db.tenants.find_one({"slug": "beta-fund"})
    member = await db.tenant_members.find_one({"tenant_id": tenant["_id"], "user_id": "ADMIN"})
    assert member["role"] == "OWNER"


async def test_creating_a_tenant_rejects_a_duplicate_slug_and_an_unknown_owner(client, stores):
    await promote_super(stores)
    client.cookies.set(COOKIE, "SUPER")
    assert (
        await client.post("/api/v1/admin/tenants", json={"name": "Tenant One", "slug": "tenant-one"})
    ).status_code == 409
    assert (
        await client.post(
            "/api/v1/admin/tenants", json={"name": "Gamma", "owner_email": "nobody@test.local"}
        )
    ).status_code == 404


async def test_slugs_are_normalised_and_validated(client, stores):
    await promote_super(stores)
    client.cookies.set(COOKIE, "SUPER")
    assert (
        await client.post("/api/v1/admin/tenants", json={"name": "  Delta   Partners LLP "})
    ).json()["data"]["slug"] == "delta-partners-llp"
    assert (await client.post("/api/v1/admin/tenants", json={"name": "!!"})).status_code == 422


async def test_suspending_a_tenant_locks_its_members_out(client, stores):
    await promote_super(stores)
    client.cookies.set(COOKIE, "SUPER")
    response = await client.post(f"/api/v1/admin/tenants/{TENANT}", json={"status": "SUSPENDED"})
    assert response.status_code == 200
    client.cookies.set(COOKIE, "ADMIN")
    client.cookies.set(TENANT_COOKIE, TENANT)
    assert (await client.get("/api/v1/accounts")).status_code == 403


async def test_my_tenants_lists_memberships_only(client, stores):
    client.cookies.set(COOKIE, "TRADER")
    data = (await client.get("/api/v1/tenants")).json()["data"]
    assert [row["slug"] for row in data["tenants"]] == ["tenant-one"]
    assert data["active"]["tenant_id"] == TENANT

    await promote_super(stores)
    client.cookies.set(COOKIE, "SUPER")
    data = (await client.get("/api/v1/tenants")).json()["data"]
    slugs = {row["slug"] for row in data["tenants"]}
    assert slugs == {"tenant-one", "tenant-two"}
    assert {row["slug"]: row["member"] for row in data["tenants"]} == {
        "tenant-one": False,
        "tenant-two": True,
    }


async def test_members_are_managed_within_the_active_tenant(client, stores):
    _, db = stores
    response = await client.get("/api/v1/members")
    assert response.status_code == 200
    assert {row["email"] for row in response.json()["data"]} == {"ekalon.consulting@gmail.com", "trader@test.local"}

    added = await client.post(
        "/api/v1/members", json={"email": "outsider@test.local", "role": "TRADER", "accounts": ["DU2"]}
    )
    assert added.status_code == 200
    member = await db.tenant_members.find_one({"tenant_id": TENANT, "user_id": "OUTSIDER"})
    assert member["role"] == "TRADER" and member["accounts"] == ["DU2"]
    assert await db.tenant_members.find_one({"tenant_id": OTHER_TENANT, "user_id": "OUTSIDER"})


async def test_members_require_an_existing_login(client):
    response = await client.post("/api/v1/members", json={"email": "ghost@test.local", "role": "VIEWER"})
    assert response.status_code == 404
    assert "Create the login first" in response.json()["error"]


async def test_a_trader_cannot_manage_members(client):
    client.cookies.set(COOKIE, "TRADER")
    assert (await client.get("/api/v1/members")).status_code == 403
    assert (
        await client.post("/api/v1/members", json={"email": "trader@test.local", "role": "OWNER"})
    ).status_code == 403


async def test_removing_a_member_archives_them_and_refuses_self_removal(client, stores):
    _, db = stores
    assert (await client.delete("/api/v1/members/ADMIN")).status_code == 409
    assert (await client.delete("/api/v1/members/TRADER")).status_code == 200
    member = await db.tenant_members.find_one({"tenant_id": TENANT, "user_id": "TRADER"})
    assert member["status"] == "ARCHIVED"
    client.cookies.set(COOKIE, "TRADER")
    assert (await client.get("/api/v1/accounts")).status_code == 403


async def test_removing_a_member_who_is_not_in_this_tenant_is_a_404(client):
    assert (await client.delete("/api/v1/members/OUTSIDER")).status_code == 404
