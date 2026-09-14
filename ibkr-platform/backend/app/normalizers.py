from datetime import UTC
from decimal import Decimal, InvalidOperation

from app.domain import Execution, Order, Position


def decimal(value):
    try:
        result = Decimal(str(value))
        return result if result.is_finite() and abs(result) < Decimal("1e100") else None
    except (InvalidOperation, ValueError):
        return None


def contract_fields(contract):
    return {
        "con_id": contract.conId,
        "symbol": contract.symbol,
        "local_symbol": contract.localSymbol,
        "sec_type": contract.secType,
        "currency": contract.currency,
        "exchange": contract.exchange,
        "expiry": contract.lastTradeDateOrContractMonth,
        "strike": decimal(contract.strike),
        "right": contract.right,
        "multiplier": decimal(contract.multiplier),
    }


def position(value):
    return Position(
        account_id=value.account,
        **contract_fields(value.contract),
        quantity=decimal(value.position),
        average_cost=decimal(value.avgCost),
    )


def portfolio(value):
    return Position(
        account_id=value.account,
        **contract_fields(value.contract),
        quantity=decimal(value.position),
        average_cost=decimal(value.averageCost),
        market_price=decimal(value.marketPrice),
        market_value=decimal(value.marketValue),
        unrealized_pnl=decimal(value.unrealizedPNL),
        realized_pnl=decimal(value.realizedPNL),
    )


def order(trade):
    source, status, contract = trade.order, trade.orderStatus, trade.contract
    timestamps = [entry.time.astimezone(UTC) for entry in trade.log if entry.time]
    fields = {"created_at": min(timestamps)} if timestamps else {}
    return Order(
        account_id=source.account,
        order_id=source.orderId,
        perm_id=source.permId,
        client_id=source.clientId,
        con_id=contract.conId,
        symbol=contract.localSymbol or contract.symbol,
        sec_type=contract.secType,
        side=source.action,
        order_type=source.orderType,
        quantity=decimal(source.totalQuantity),
        limit_price=decimal(source.lmtPrice),
        aux_price=decimal(source.auxPrice),
        filled_quantity=decimal(status.filled),
        remaining_quantity=decimal(status.remaining),
        status=status.status,
        **fields,
    )


def execution(fill):
    source = fill.execution
    report = fill.commissionReport
    has_report = bool(report.execId)
    return Execution(
        execution_id=source.execId,
        account_id=source.acctNumber,
        order_id=source.orderId,
        perm_id=source.permId,
        con_id=fill.contract.conId,
        symbol=fill.contract.localSymbol or fill.contract.symbol,
        underlying=fill.contract.symbol or None,
        currency=fill.contract.currency or None,
        sec_type=fill.contract.secType or None,
        expiry=fill.contract.lastTradeDateOrContractMonth or None,
        multiplier=str(fill.contract.multiplier) if fill.contract.multiplier else None,
        side=source.side,
        quantity=decimal(source.shares),
        price=decimal(source.price),
        exchange=source.exchange,
        commission=decimal(report.commission) if has_report else None,
        realized_pnl=decimal(report.realizedPNL) if has_report else None,
        executed_at=source.time.astimezone(UTC),
    )


ACCOUNT_TAGS = {
    "NetLiquidation": "net_liquidation",
    "TotalCashValue": "cash",
    "BuyingPower": "buying_power",
    "AvailableFunds": "available_funds",
    "ExcessLiquidity": "excess_liquidity",
    "InitMarginReq": "initial_margin",
    "MaintMarginReq": "maintenance_margin",
    "GrossPositionValue": "gross_position_value",
    "RealizedPnL": "realized_pnl",
    "UnrealizedPnL": "unrealized_pnl",
}
