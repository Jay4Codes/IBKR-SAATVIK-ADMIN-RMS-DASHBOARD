from tests.conftest import TENANT


async def execution(db, tenant, account, execution_id, *, executed_at, commission=None):
    await db.executions.update_one(
        {"_id": f"{tenant}:{execution_id}"},
        {
            "$set": {
                "tenant_id": tenant,
                "account_id": account,
                "execution_id": execution_id,
                "order_id": 1,
                "perm_id": 1,
                "con_id": 1,
                "symbol": "SPX",
                "side": "BOT",
                "quantity": "1",
                "price": "1",
                "exchange": "CBOE",
                "commission": commission,
                "realized_pnl": None,
                "executed_at": executed_at,
            }
        },
        upsert=True,
    )

async def test_commissions_are_summed_by_day_and_account(client, stores):
    _, db = stores
    await execution(db, TENANT, "DU1", "e1", executed_at="2026-09-01T10:00:00+00:00", commission="1.50")
    await execution(db, TENANT, "DU1", "e2", executed_at="2026-09-01T11:00:00+00:00", commission="2.25")
    await execution(db, TENANT, "DU2", "e3", executed_at="2026-09-02T09:00:00+00:00", commission="0.75")
    await execution(db, TENANT, "DU1", "e4", executed_at="2026-09-02T09:00:00+00:00", commission=None)
    body = (await client.get("/api/v1/commissions")).json()["data"]
    assert body["total"] == "4.50"
    assert body["count"] == 3
    assert body["by_day"] == [
        {"date": "2026-09-01", "commission": "3.75"},
        {"date": "2026-09-02", "commission": "0.75"},
    ]
    assert body["by_account"] == [
        {"account_id": "DU1", "commission": "3.75"},
        {"account_id": "DU2", "commission": "0.75"},
    ]
    assert body["fills"] == [
        {"execution_id": "e1", "account_id": "DU1", "commission": "1.50", "expiry": None},
        {"execution_id": "e2", "account_id": "DU1", "commission": "2.25", "expiry": None},
        {"execution_id": "e3", "account_id": "DU2", "commission": "0.75", "expiry": None},
    ]

async def test_commissions_can_be_scoped_to_one_account(client, stores):
    _, db = stores
    await execution(db, TENANT, "DU1", "e1", executed_at="2026-09-01T10:00:00+00:00", commission="1.50")
    await execution(db, TENANT, "DU2", "e2", executed_at="2026-09-01T10:00:00+00:00", commission="9.00")
    body = (await client.get("/api/v1/accounts/DU1/commissions")).json()["data"]
    assert body["total"] == "1.50"
    assert body["count"] == 1

async def test_commissions_respect_a_date_window(client, stores):
    _, db = stores
    await execution(db, TENANT, "DU1", "e1", executed_at="2026-09-01T10:00:00+00:00", commission="1.00")
    await execution(db, TENANT, "DU1", "e2", executed_at="2026-09-05T10:00:00+00:00", commission="2.00")
    body = (
        await client.get("/api/v1/commissions?since=2026-09-03T00:00:00+00:00")
    ).json()["data"]
    assert body["total"] == "2.00"
