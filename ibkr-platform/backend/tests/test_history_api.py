import pytest

from app import flex
from app.auth import COOKIE
from app.db import snapshot_id
from tests.conftest import OTHER_TENANT, TENANT

STATEMENT = """<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse queryName="NAV" type="AF">
 <FlexStatements count="1">
  <FlexStatement accountId="DU1" fromDate="20260901" toDate="20260903">
   <EquitySummaryInBase>
    <EquitySummaryByReportDateInBase accountId="DU1" reportDate="20260901" total="100000.00" currency="USD" />
    <EquitySummaryByReportDateInBase accountId="DU1" reportDate="2026-09-02" total="101500.50" currency="USD" />
    <EquitySummaryByReportDateInBase accountId="DU9" reportDate="20260902" total="9999.00" currency="USD" />
    <EquitySummaryByReportDateInBase accountId="DU1" reportDate="" total="123.00" currency="USD" />
    <EquitySummaryByReportDateInBase accountId="DU1" reportDate="20260903" total="" currency="USD" />
   </EquitySummaryInBase>
  </FlexStatement>
 </FlexStatements>
</FlexQueryResponse>"""


def as_user(role):
    return {COOKIE: role}


async def snapshot(db, tenant, account, date, value, *, bucket="", source="snapshot", taken=None):
    await db.account_snapshots.update_one(
        {"_id": snapshot_id(tenant, account, date, bucket)},
        {
            "$set": {
                "tenant_id": tenant,
                "account_id": account,
                "report_date": date,
                "taken_at": taken or f"{date}T{bucket or '00'}:00:00+00:00",
                "currency": "USD",
                "net_liquidation": value,
                "source": source,
            }
        },
        upsert=True,
    )


def test_flex_keeps_only_rows_it_can_trust():
    points = flex.parse_statement(STATEMENT)
    assert [(p.account_id, p.report_date, str(p.net_liquidation)) for p in points] == [
        ("DU1", "2026-09-01", "100000.00"),
        ("DU1", "2026-09-02", "101500.50"),
        ("DU9", "2026-09-02", "9999.00"),
    ]


def test_flex_reports_the_brokers_own_refusal():
    with pytest.raises(flex.FlexError) as raised:
        flex.parse_statement(
            '<FlexStatementResponse><Status>Fail</Status><ErrorCode>1015</ErrorCode>'
            "<ErrorMessage>Invalid token</ErrorMessage></FlexStatementResponse>"
        )
    assert raised.value.code == "1015"
    assert "Invalid token" in str(raised.value)


async def test_history_returns_one_close_per_day(client, stores):
    _, db = stores
    await snapshot(db, TENANT, "DU1", "2026-09-01", "100.00", bucket="09")
    await snapshot(db, TENANT, "DU1", "2026-09-01", "140.00", bucket="15")
    await snapshot(db, TENANT, "DU1", "2026-09-02", "150.00", bucket="09")
    body = (await client.get("/api/v1/accounts/DU1/history")).json()["data"]
    assert [(r["report_date"], r["net_liquidation"]) for r in body] == [
        ("2026-09-01", "140.00"),
        ("2026-09-02", "150.00"),
    ]


async def test_a_flex_row_supersedes_the_days_samples(client, stores):
    _, db = stores
    await snapshot(db, TENANT, "DU1", "2026-09-01", "140.00", bucket="15")
    await snapshot(
        db, TENANT, "DU1", "2026-09-01", "138.25",
        source="flex", taken="2026-09-01T23:59:59.999999+00:00",
    )
    body = (await client.get("/api/v1/accounts/DU1/history")).json()["data"]
    assert [(r["net_liquidation"], r["source"]) for r in body] == [("138.25", "flex")]


async def test_the_combined_line_adds_the_accounts_together(client, stores):
    _, db = stores
    for date, a, b in [("2026-09-01", "100", "50"), ("2026-09-02", "110", "45")]:
        await snapshot(db, TENANT, "DU1", date, a)
        await snapshot(db, TENANT, "DU2", date, b)
    body = (await client.get("/api/v1/history")).json()["data"]
    assert body["accounts"] == ["DU1", "DU2"]
    assert [(r["report_date"], r["net_liquidation"]) for r in body["combined"]] == [
        ("2026-09-01", "150"),
        ("2026-09-02", "155"),
    ]
    assert len(body["series"]) == 4


async def test_a_day_missing_an_account_is_left_out_of_the_total(client, stores):
    _, db = stores
    await snapshot(db, TENANT, "DU1", "2026-09-01", "100")
    await snapshot(db, TENANT, "DU2", "2026-09-01", "50")
    await snapshot(db, TENANT, "DU1", "2026-09-02", "110")
    body = (await client.get("/api/v1/history")).json()["data"]
    assert [r["report_date"] for r in body["combined"]] == ["2026-09-01"]


async def test_history_can_be_narrowed_to_a_range(client, stores):
    _, db = stores
    for date in ("2026-09-01", "2026-09-02", "2026-09-03"):
        await snapshot(db, TENANT, "DU1", date, "100")
    body = (await client.get("/api/v1/accounts/DU1/history?since=2026-09-02&until=2026-09-02")).json()
    assert [r["report_date"] for r in body["data"]] == ["2026-09-02"]


async def test_a_trader_cannot_read_an_account_they_were_not_granted(client, stores):
    _, db = stores
    await snapshot(db, TENANT, "DU2", "2026-09-01", "50")
    assert (await client.get("/api/v1/accounts/DU2/history", cookies=as_user("TRADER"))).status_code == 403
    body = (await client.get("/api/v1/history", cookies=as_user("TRADER"))).json()["data"]
    assert body["accounts"] == ["DU1"]


async def test_another_tenants_history_is_invisible(client, stores):
    _, db = stores
    await snapshot(db, OTHER_TENANT, "DU9", "2026-09-01", "9999")
    await snapshot(db, TENANT, "DU1", "2026-09-01", "100")
    body = (await client.get("/api/v1/history")).json()["data"]
    assert {r["account_id"] for r in body["series"]} == {"DU1"}


async def test_backfill_writes_only_this_tenants_accounts(client, stores, monkeypatch):
    _, db = stores

    async def statement(*args, **kwargs):
        return flex.parse_statement(STATEMENT)

    monkeypatch.setattr(flex, "fetch_history", statement)
    body = (await client.post("/api/v1/admin/history/backfill")).json()["data"]
    assert body == {"written": 2, "skipped_other_tenants": 1, "points": 3}
    rows = await db.account_snapshots.find({}).to_list(10)
    assert {r["account_id"] for r in rows} == {"DU1"}
    assert all(r["source"] == "flex" for r in rows)


async def test_backfill_surfaces_a_flex_refusal_rather_than_a_500(client, monkeypatch):
    async def refuse(*args, **kwargs):
        raise flex.FlexError("1015", "Invalid token")

    monkeypatch.setattr(flex, "fetch_history", refuse)
    response = await client.post("/api/v1/admin/history/backfill")
    assert response.status_code == 502
    assert "1015" in response.json()["error"]


async def test_backfill_is_refused_to_a_plain_member(client):
    assert (await client.post("/api/v1/admin/history/backfill", cookies=as_user("TRADER"))).status_code == 403


async def intraday_point(db, tenant, account, stamp, day_pnl, date="2026-09-10"):
    await db.account_snapshots.update_one(
        {"_id": f"{tenant}:{account}:{date}:{stamp}"},
        {
            "$set": {
                "tenant_id": tenant,
                "account_id": account,
                "report_date": date,
                "taken_at": f"{date}T{stamp}:00+00:00",
                "currency": "USD",
                "net_liquidation": "5000",
                "day_pnl": day_pnl,
                "source": "snapshot",
            }
        },
        upsert=True,
    )


async def test_intraday_keeps_every_point_rather_than_a_daily_close(client, stores):
    _, db = stores
    for stamp, pnl in [("09:35", "10"), ("09:40", "-5"), ("09:45", "22")]:
        await intraday_point(db, TENANT, "DU1", stamp, pnl)
    body = (await client.get("/api/v1/history/intraday?date=2026-09-10")).json()["data"]
    assert [r["day_pnl"] for r in body["series"]] == ["10", "-5", "22"]
    assert [c["day_pnl"] for c in body["combined"]] == ["10", "-5", "22"]


async def test_intraday_adds_the_accounts_at_each_timestamp(client, stores):
    _, db = stores
    for stamp, a, b in [("09:35", "10", "4"), ("09:40", "-5", "1")]:
        await intraday_point(db, TENANT, "DU1", stamp, a)
        await intraday_point(db, TENANT, "DU2", stamp, b)
    body = (await client.get("/api/v1/history/intraday?date=2026-09-10")).json()["data"]
    assert [(c["taken_at"][11:16], c["day_pnl"]) for c in body["combined"]] == [
        ("09:35", "14"),
        ("09:40", "-4"),
    ]


async def test_a_timestamp_missing_an_account_is_left_out_of_the_total(client, stores):
    _, db = stores
    await intraday_point(db, TENANT, "DU1", "09:35", "10")
    await intraday_point(db, TENANT, "DU2", "09:35", "4")
    await intraday_point(db, TENANT, "DU1", "09:40", "-5")
    body = (await client.get("/api/v1/history/intraday?date=2026-09-10")).json()["data"]
    assert [c["taken_at"][11:16] for c in body["combined"]] == ["09:35"]


async def test_intraday_skips_a_point_the_broker_never_valued(client, stores):
    _, db = stores
    await intraday_point(db, TENANT, "DU1", "09:35", None)
    await intraday_point(db, TENANT, "DU1", "09:40", "12")
    body = (await client.get("/api/v1/history/intraday?date=2026-09-10")).json()["data"]
    assert len(body["series"]) == 2
    assert [c["day_pnl"] for c in body["combined"]] == ["12"]


async def test_intraday_excludes_a_flex_row(client, stores):
    _, db = stores
    await intraday_point(db, TENANT, "DU1", "09:35", "10")
    await snapshot(db, TENANT, "DU1", "2026-09-10", "5000", source="flex")
    body = (await client.get("/api/v1/history/intraday?date=2026-09-10")).json()["data"]
    assert [r["source"] for r in body["series"]] == ["snapshot"]


async def test_intraday_respects_account_grants(client, stores):
    _, db = stores
    await intraday_point(db, TENANT, "DU2", "09:35", "4")
    assert (
        await client.get("/api/v1/history/intraday?accounts=DU2", cookies=as_user("TRADER"))
    ).status_code == 403
