from datetime import UTC, datetime
from decimal import Decimal

import pytest
from ib_async import CommissionReport, Contract, Fill, Order, OrderStatus, Trade
from ib_async import Execution as IBExecution
from ib_async.objects import Position

from app import normalizers as norm


@pytest.mark.parametrize("value", [None, "", float("nan"), float("inf"), 1.7976931348623157e308])
def test_missing_money(value):
    assert norm.decimal(value) is None

def test_precision():
    assert norm.decimal("0.1234567890123456789") == Decimal("0.1234567890123456789")

@pytest.mark.parametrize("sec_type", ["STK", "OPT", "FUT", "CASH"])
def test_positions(sec_type):
    value = Position(
        "DU1",
        Contract(
            conId=123,
            symbol="SPX",
            secType=sec_type,
            currency="USD",
            lastTradeDateOrContractMonth="20260918",
            strike=6000,
            right="C",
            multiplier="100",
        ),
        Decimal("-2"),
        1250.25,
    )
    normalized = norm.position(value)
    assert normalized.con_id == 123
    assert normalized.quantity == Decimal("-2")
    assert normalized.average_cost == Decimal("1250.25")
    assert normalized.market_price is None
    assert normalized.updated_at.tzinfo == UTC
    assert normalized.model_dump(mode="json")["quantity"] == "-2"

def test_order_client_identity_and_unset_prices():
    trade = Trade(
        Contract(conId=123, symbol="AAPL", secType="STK"),
        Order(account="DU1", clientId=8, orderId=5, permId=100, action="BUY", totalQuantity=10),
        OrderStatus(status="Submitted", filled=2, remaining=8),
    )
    result = norm.order(trade)
    assert result.key == "DU1:perm:100"
    assert result.limit_price is None
    assert result.filled_quantity == Decimal(2)

def test_execution_commission_arrives_later():
    fill = Fill(
        Contract(conId=1, symbol="AAPL"),
        IBExecution(execId="fill-1", acctNumber="DU1", shares=3, price=12.1, time=datetime.now(UTC)),
        CommissionReport(),
        datetime.now(UTC),
    )
    assert norm.execution(fill).commission is None
    fill.commissionReport.execId = "fill-1"
    fill.commissionReport.commission = 0.35
    assert norm.execution(fill).commission == Decimal("0.35")
