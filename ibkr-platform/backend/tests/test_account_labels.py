from tests.conftest import TENANT


async def test_an_account_starts_with_no_name(client, stores):
    rows = (await client.get("/api/v1/accounts")).json()["data"]
    assert rows
    assert all(row["label"] == "" for row in rows)

async def test_naming_an_account_sticks_and_is_tenant_wide(client, stores):
    _, db = stores
    account = (await client.get("/api/v1/accounts")).json()["data"][0]["account_id"]
    body = (await client.patch(f"/api/v1/accounts/{account}", json={"label": "Income book"})).json()["data"]
    assert body["label"] == "Income book"

    rows = (await client.get("/api/v1/accounts")).json()["data"]
    assert next(r for r in rows if r["account_id"] == account)["label"] == "Income book"

    doc = await db.ibkr_accounts.find_one({"tenant_id": TENANT, "account_id": account})
    assert doc["label"] == "Income book"

async def test_a_name_can_be_cleared_and_is_trimmed(client, stores):
    account = (await client.get("/api/v1/accounts")).json()["data"][0]["account_id"]
    assert (await client.patch(f"/api/v1/accounts/{account}", json={"label": "  Hedge  "})).json()["data"]["label"] == "Hedge"
    assert (await client.patch(f"/api/v1/accounts/{account}", json={"label": ""})).json()["data"]["label"] == ""

async def test_an_absurd_name_is_cut_rather_than_refused(client, stores):
    account = (await client.get("/api/v1/accounts")).json()["data"][0]["account_id"]
    body = (await client.patch(f"/api/v1/accounts/{account}", json={"label": "x" * 500})).json()["data"]
    assert len(body["label"]) == 60

async def test_only_an_administrator_may_rename(client, stores):
    from httpx import ASGITransport, AsyncClient

    from app.auth import COOKIE, TENANT_COOKIE
    from app.main import app

    account = (await client.get("/api/v1/accounts")).json()["data"][0]["account_id"]
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        cookies={COOKIE: "TRADER", TENANT_COOKIE: TENANT},
        headers={"Origin": "http://localhost:3000"},
    ) as trader:

        assert (await trader.patch(f"/api/v1/accounts/{account}", json={"label": "Mine"})).status_code == 403

async def test_a_tenant_owner_who_is_not_platform_admin_may_rename(client, stores):
    _, db = stores
    await db.users.update_one({"_id": "ADMIN"}, {"$set": {"email": "owner@test.local", "is_super_admin": False}})
    me = (await client.get("/api/v1/auth/me")).json()["data"]
    assert me["is_super_admin"] is False and me["role"] == "ADMIN"
    account = (await client.get("/api/v1/accounts")).json()["data"][0]["account_id"]
    assert (await client.patch(f"/api/v1/accounts/{account}", json={"label": "Desk A"})).json()["data"]["label"] == "Desk A"
