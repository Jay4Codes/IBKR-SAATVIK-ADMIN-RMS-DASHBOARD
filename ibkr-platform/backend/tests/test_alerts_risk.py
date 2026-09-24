from decimal import Decimal

import pytest

from app import telegram
from app.alerts import position_changes, risk_message, worst_terminal_at
from app.config import settings
from app.worker import AlertDispatcher
from tests.test_alerts_gateway import FakeRedis


def leg(con_id, strike, quantity, right="P", expiry="20260924", spot="7764.64", cost="500"):
    return {
        "con_id": con_id, "symbol": "SPX", "sec_type": "OPT", "currency": "USD",
        "expiry": expiry, "strike": str(strike), "right": right, "multiplier": "100",
        "quantity": str(quantity), "average_cost": cost, "underlying_price": spot,
    }

def test_the_worst_case_says_where_it_happens():
    book = [leg(1, 7700, -2), leg(2, 7695, 2)]
    pnl, at = worst_terminal_at(book, Decimal("7764.64"))
    assert at == Decimal("7695")
    assert pnl == Decimal(-2) * (Decimal(5) * 100 - 500) + Decimal(2) * (0 - 500)

def test_position_changes_read_as_what_the_desk_did():
    before = {1: leg(1, 7700, 2), 3: leg(3, 7650, 1)}
    after = {1: leg(1, 7700, 1), 2: leg(2, 7695, -2), 3: leg(3, 7650, 1)}
    assert position_changes(before, after) == [
        "sold 2 × SPX 24 Sep 26 7695 Put",
        "sold 1 × SPX 24 Sep 26 7700 Put (now 1)",
    ]
    assert position_changes(after, {}) == [
        "closed 1 × SPX 24 Sep 26 7650 Put",
        "closed 2 × SPX 24 Sep 26 7695 Put",
        "closed 1 × SPX 24 Sep 26 7700 Put",
    ]

def test_a_risk_alert_explains_itself():
    text = risk_message(
        "U1", Decimal("-16400.63"), Decimal("-9067.89"),
        symbol="SPX", spot=Decimal("7764.64"), spot_before=Decimal("7764.64"),
        worst_at=Decimal("7300"), changes=["sold 2 × SPX 24 Sep 26 7700 Put"],
    )
    assert "Could lose up to <b>16,400.63</b>" in text
    assert "settles at 7,300.00 (-6.0% from 7,764.64)" in text
    assert "worse by 7,332.74 (81%)" in text
    assert "Because you sold 2 × SPX 24 Sep 26 7700 Put." in text
    moved = risk_message(
        "U1", Decimal("-5000"), Decimal("-4000"),
        symbol="SPX", spot=Decimal("7720"), spot_before=Decimal("7764.64"), worst_at=Decimal("7300"),
    )
    assert "No position changed; SPX moved 7,764.64 → 7,720.00." in moved
    safe = risk_message("U1", Decimal("1200"), Decimal("900"))
    assert "Keeps at least <b>1,200.00</b>" in safe and "better by 300.00" in safe

@pytest.mark.asyncio
async def test_a_spread_arriving_leg_by_leg_is_one_alert_about_the_spread(monkeypatch):
    monkeypatch.setattr(settings, "alert_risk_settle_seconds", 1000)
    sent: list[str] = []

    async def send(client, chat_id, text):
        sent.append(text)

    monkeypatch.setattr(telegram, "send", send)
    worker = AlertDispatcher(FakeRedis(), None, "t1")
    book: list[dict] = [leg(1, 7700, 2)]

    async def positions_for(account_id):
        return list(book)

    async def recipients(account_id):
        return ["111"]

    async def members(trigger):
        return [({"user_id": "u", "chat_id": "111"}, {"risk_percent": "10"})]

    async def common_prefs():
        return None

    async def underlying_moved(client, data):
        return None

    raised: list[str] = []

    async def raise_alert(trigger, account_id, text, urgent):
        raised.append(text)

    for name, stub in (
        ("positions_for", positions_for), ("recipients", recipients), ("members", members),
        ("common_prefs", common_prefs), ("underlying_moved", underlying_moved), ("raise_alert", raise_alert),
    ):
        setattr(worker, name, stub)

    await worker.handle(None, {"event_type": "position.updated", "account_id": "U1", "data": {"symbol": "SPX"}})
    worker.state.dirty["U1"] = 0
    await worker.settle_risk(None)
    assert sent == [], "the first look at a book only sets the baseline"

    book.append(leg(2, 7695, -2, cost="300"))
    await worker.handle(None, {"event_type": "position.updated", "account_id": "U1", "data": {"symbol": "SPX"}})
    book.append(leg(3, 7690, 2, cost="100"))
    await worker.handle(None, {"event_type": "position.updated", "account_id": "U1", "data": {"symbol": "SPX"}})
    await worker.settle_risk(None)
    assert sent == [], "nothing fires while the legs are still landing"

    worker.state.dirty["U1"] = 0
    await worker.settle_risk(None)
    assert len(sent) == 1 and raised == sent
    assert "sold 2 × SPX 24 Sep 26 7695 Put" in sent[0]
    assert "bought 2 × SPX 24 Sep 26 7690 Put" in sent[0]
    assert "Worst-case risk" in sent[0]
    assert "U1" not in worker.state.dirty
