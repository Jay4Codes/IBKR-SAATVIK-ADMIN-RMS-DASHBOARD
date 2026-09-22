from tests.conftest import TENANT


async def execution(
    db, tenant, account, execution_id, *, realized=None, commission=None, expiry="20260918", currency="USD"
):
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
                "symbol": f"SPXW  {expiry[2:]}P07480000",
                "underlying": "SPX",
                "currency": currency,
                "sec_type": "OPT",
                "expiry": expiry,
                "side": "SLD",
                "quantity": "1",
                "price": "1",
                "exchange": "CBOE",
                "commission": commission,
                "realized_pnl": realized,
                "executed_at": "2026-09-11T19:17:22+00:00",
            }
        },
        upsert=True,
    )


async def test_realized_totals_the_closed_legs(client, stores):
    _, db = stores
    await execution(db, TENANT, "DU1", "e1", realized="-1265.36", commission="1.73")
    await execution(db, TENANT, "DU2", "e2", realized="400.00", commission="1.00")
    body = (await client.get("/api/v1/realized")).json()["data"]
    assert body["total"] == "-865.36"
    assert body["commission"] == "2.73"
    assert body["count"] == 2
    assert body["by_account"] == [
        {"account_id": "DU1", "realized_pnl": "-1265.36"},
        {"account_id": "DU2", "realized_pnl": "400.00"},
    ]


async def test_an_opening_fill_books_nothing_but_still_costs_commission(client, stores):
    """It realises no P&L and is not counted as though it had.

    Its commission is another matter: the desk paid it to hold the position the
    payoff is modelling. Leaving it out made "include commissions" do nothing on
    a book that had not been adjusted yet — every fill was an opening one, so
    every commission was invisible.
    """
    _, db = stores
    await execution(db, TENANT, "DU1", "e1", realized="0.0", commission="1.73")
    await execution(db, TENANT, "DU1", "e2", realized="-100.00", commission="1.00")
    body = (await client.get("/api/v1/realized")).json()["data"]
    assert body["total"] == "-100.00"
    assert body["count"] == 1
    assert body["commission"] == "2.73"
    assert len(body["legs"]) == 2


async def test_a_book_with_no_closings_still_reports_what_it_cost(client, stores):
    """The live case: six opening fills, nothing booked, eleven dollars spent."""
    _, db = stores
    for index in range(6):
        await execution(db, TENANT, "DU1", f"open{index}", realized="0.0", commission="1.84")
    body = (await client.get("/api/v1/realized")).json()["data"]
    assert body["total"] == "0"
    assert body["count"] == 0
    assert body["commission"] == "11.04"


async def test_realized_is_narrowed_to_the_modelled_expiry_cycle(client, stores):
    _, db = stores
    await execution(db, TENANT, "DU1", "e1", realized="-1265.36", expiry="20260918")
    await execution(db, TENANT, "DU1", "e2", realized="-9999.00", expiry="20260821")
    body = (await client.get("/api/v1/realized?expiries=20260918")).json()["data"]
    assert body["total"] == "-1265.36"
    assert body["legs"][0]["expiry"] == "20260918"
    every = (await client.get("/api/v1/realized")).json()["data"]
    assert every["total"] == "-11264.36"


async def test_realized_can_be_scoped_to_one_account(client, stores):
    _, db = stores
    await execution(db, TENANT, "DU1", "e1", realized="-1265.36")
    await execution(db, TENANT, "DU2", "e2", realized="500.00")
    body = (await client.get("/api/v1/realized?accounts=DU1")).json()["data"]
    assert body["total"] == "-1265.36"
    assert body["count"] == 1


async def test_realized_legs_carry_what_the_panel_groups_on(client, stores):
    _, db = stores
    await execution(db, TENANT, "DU1", "e1", realized="-1265.36", commission="1.73")
    leg = (await client.get("/api/v1/realized")).json()["data"]["legs"][0]
    assert leg["underlying"] == "SPX"
    assert leg["currency"] == "USD"
    assert leg["expiry"] == "20260918"
    assert leg["realized_pnl"] == "-1265.36"
    assert leg["commission"] == "1.73"


async def test_an_expired_cycle_drops_out_once_it_has_passed(client, stores):
    _, db = stores
    await execution(db, TENANT, "DU1", "live", realized="-1265.36", expiry="20260918")
    await execution(db, TENANT, "DU1", "gone", realized="-9999.00", expiry="20260821")
    body = (await client.get("/api/v1/realized?active_on=20260914")).json()["data"]
    assert body["total"] == "-1265.36"
    assert body["count"] == 1
    after = (await client.get("/api/v1/realized?active_on=20260919")).json()["data"]
    assert after["total"] == "0"
    assert after["count"] == 0


async def test_named_expiries_win_over_the_active_day(client, stores):
    _, db = stores
    await execution(db, TENANT, "DU1", "e1", realized="-100.00", expiry="20260918")
    await execution(db, TENANT, "DU1", "e2", realized="-200.00", expiry="20260922")
    body = (
        await client.get("/api/v1/realized?expiries=20260922&active_on=20260914")
    ).json()["data"]
    assert body["total"] == "-200.00"
