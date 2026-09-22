import asyncio
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app import massive
from app.db import persist, scoped_id
from app.domain import Event, GatewayStatus
from app.tenancy import TenantKeys
from app.worker import GatewaySession, backoff, durable_consumer
from tests.conftest import CONNECTION, TENANT, gateway_connection


def keep(db, event):
    return persist(db, event, tenant_id=TENANT, connection_id=CONNECTION)

def session(redis, db, ib=None, **overrides):
    connection = {**gateway_connection(TENANT, CONNECTION, "Gateway", 4101), **overrides}
    return GatewaySession(redis, db, TENANT, connection, ib or MagicMock())

async def test_immutable_fill_with_commission_enrichment(stores):
    _, db = stores
    data = {
        "execution_id": "x1",
        "account_id": "DU1",
        "price": "100.01",
        "quantity": "2",
        "commission": None,
        "realized_pnl": None,
    }
    await keep(db, Event(event_type="execution.created", account_id="DU1", data=data))
    await keep(
        db,
        Event(
            event_type="execution.created",
            account_id="DU1",
            data={**data, "price": "999", "commission": "0.35"},
        ),
    )
    assert await db.executions.count_documents({}) == 1
    fill = await db.executions.find_one({"_id": scoped_id(TENANT, "x1")})
    assert fill["price"] == "100.01"
    assert fill["commission"] == "0.35"
    assert fill["tenant_id"] == TENANT

async def test_same_fill_id_in_two_tenants_stays_two_records(stores):
    _, db = stores
    data = {"execution_id": "shared", "account_id": "DU1", "price": "1"}
    event = Event(event_type="execution.created", account_id="DU1", data=data)
    await persist(db, event, tenant_id=TENANT, connection_id=CONNECTION)
    await persist(db, event, tenant_id="tenant-two", connection_id="connection-two")
    assert await db.executions.count_documents({}) == 2
    assert await db.executions.count_documents({"tenant_id": TENANT}) == 1

async def test_order_history_retains_created_at(stores):
    _, db = stores
    data = {
        "account_id": "DU1",
        "client_id": 1,
        "order_id": 1,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
        "status": "Submitted",
    }
    first = Event(event_type="order.updated", account_id="DU1", data=data)
    await keep(db, first)
    await keep(db, first)
    await keep(
        db,
        Event(
            event_type="order.filled",
            account_id="DU1",
            data={**data, "created_at": "2026-01-02T00:00:00Z", "status": "Filled"},
        ),
    )
    assert await db.order_events.count_documents({}) == 2
    assert (await db.orders.find_one({}))["created_at"] == data["created_at"]

def test_backoff_is_capped():
    with patch("app.worker.random.uniform", return_value=0):
        assert backoff(1) == 2
        assert backoff(2) == 4
        assert backoff(10000) == 60

async def test_a_held_lease_stops_a_second_session(stores):
    redis, db = stores
    await redis.set(TenantKeys(TENANT).lease(CONNECTION), "another-worker")
    ib = MagicMock()
    await session(redis, db, ib).run()
    ib.connectAsync.assert_not_called()

async def test_leases_are_per_connection(stores):
    redis, db = stores
    first = session(redis, db)
    assert await first.acquire()
    second = GatewaySession(
        redis, db, "tenant-two", gateway_connection("tenant-two", "connection-two", "Other", 4102)
    )
    assert await second.acquire()

async def test_callback_error_is_visible(stores):
    redis, db = stores
    worker = session(redis, db)
    worker.callback(lambda: 1 / 0)()
    assert worker.fault.is_set()
    assert "division" in worker.state.last_error

async def test_connect_failure_retries_and_stops(stores, monkeypatch):
    redis, db = stores
    ib = MagicMock()
    ib.connectAsync = AsyncMock(side_effect=ConnectionError("gateway unavailable"))
    worker = session(redis, db, ib)
    monkeypatch.setattr("app.worker.backoff", lambda _: 0.001)
    task = asyncio.create_task(worker.live())
    for _ in range(100):
        if ib.connectAsync.call_count >= 2:
            break
        await asyncio.sleep(0.005)
    worker.stop.set()
    await asyncio.wait_for(task, 1)
    assert ib.connectAsync.call_count >= 2
    assert "unavailable" in worker.state.last_error
    assert worker.state.disconnected_at
    ib.disconnect.assert_called()

async def test_a_connection_without_a_port_never_dials(stores, monkeypatch):
    redis, db = stores
    ib = MagicMock()
    ib.connectAsync = AsyncMock()
    worker = session(redis, db, ib, api_port=0)
    monkeypatch.setattr("app.worker.backoff", lambda _: 0.001)
    task = asyncio.create_task(worker.live())
    await asyncio.sleep(0.05)
    worker.stop.set()
    await asyncio.wait_for(task, 1)
    ib.connectAsync.assert_not_called()
    assert "no API port" in worker.state.last_error

async def test_durable_stream_consumer_ack(stores):
    redis, db = stores
    keys = TenantKeys(TENANT)
    event = Event(
        event_type="execution.created", account_id="DU1", data={"execution_id": "fill1", "account_id": "DU1"}
    )
    await redis.xadd(keys.events, {"event": event.model_dump_json(), "connection_id": CONNECTION})
    stop = asyncio.Event()
    task = asyncio.create_task(durable_consumer(redis, db, TENANT, stop))
    try:
        for _ in range(100):
            if await db.executions.count_documents({}):
                break
            await asyncio.sleep(0.01)
        assert await db.executions.count_documents({}) == 1
        assert (await db.executions.find_one({}))["tenant_id"] == TENANT
        pending = await redis.xpending(keys.events, keys.consumer_group)
        assert pending["pending"] == 0
    finally:
        stop.set()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

async def test_history_retries_unacknowledged_events(stores, monkeypatch):
    redis, db = stores
    keys = TenantKeys(TENANT)
    attempts = 0

    async def flaky(db, event, *, tenant_id, connection_id):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise ConnectionError("MongoDB unavailable")
        await persist(db, event, tenant_id=tenant_id, connection_id=connection_id)

    monkeypatch.setattr("app.worker.persist", flaky)
    event = Event(
        event_type="execution.created", account_id="DU1", data={"execution_id": "retry1", "account_id": "DU1"}
    )
    await redis.xadd(keys.events, {"event": event.model_dump_json(), "connection_id": CONNECTION})
    stop = asyncio.Event()
    task = asyncio.create_task(durable_consumer(redis, db, TENANT, stop))
    try:
        async with asyncio.timeout(5):
            while not await db.executions.count_documents({}):
                await asyncio.sleep(0.02)
        assert attempts == 2
        assert (await redis.xpending(keys.events, keys.consumer_group))["pending"] == 0
    finally:
        stop.set()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

async def test_target_prefers_operator_override(stores):
    redis, db = stores
    worker = session(redis, db)
    host, port, client_id = await worker.target()
    assert (host, port, client_id) == ("127.0.0.1", 4101, 17)
    await redis.set(
        TenantKeys(TENANT).target(CONNECTION),
        '{"host": "gw.internal", "port": 4001, "client_id": 21}',
    )
    assert await worker.target() == ("gw.internal", 4001, 21)
    assert (worker.state.host, worker.state.port, worker.state.client_id) == ("gw.internal", 4001, 21)

async def test_reconnect_command_sets_events(stores):
    redis, db = stores
    worker = session(redis, db)
    worker.command({"command": "reconnect"})
    assert worker.reconnect.is_set()
    assert worker.fault.is_set()

async def test_unsupported_command_is_ignored(stores):
    redis, db = stores
    worker = session(redis, db)
    worker.command({"command": "place_order"})
    assert not worker.reconnect.is_set()
    assert not worker.fault.is_set()

async def test_supervisor_routes_commands_to_the_named_session(stores):
    from app.tenancy import COMMAND_CHANNEL
    from app.worker import Supervisor

    redis, db = stores
    supervisor = Supervisor(redis, db)
    mine = session(redis, db)
    theirs = GatewaySession(
        redis, db, "tenant-two", gateway_connection("tenant-two", "connection-two", "Other", 4102)
    )
    supervisor.sessions = {CONNECTION: (mine, MagicMock()), "connection-two": (theirs, MagicMock())}
    task = asyncio.create_task(supervisor.commands())
    await asyncio.sleep(0.1)
    import json as _json

    for _ in range(40):
        await redis.publish(
            COMMAND_CHANNEL,
            _json.dumps({"command": "reconnect", "tenant_id": TENANT, "connection_id": CONNECTION}),
        )
        if mine.reconnect.is_set():
            break
        await asyncio.sleep(0.05)
    supervisor.stop.set()
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert mine.reconnect.is_set()
    assert not theirs.reconnect.is_set()

async def test_a_command_naming_the_wrong_tenant_is_refused(stores):
    from app.tenancy import COMMAND_CHANNEL
    from app.worker import Supervisor

    redis, db = stores
    supervisor = Supervisor(redis, db)
    mine = session(redis, db)
    supervisor.sessions = {CONNECTION: (mine, MagicMock())}
    task = asyncio.create_task(supervisor.commands())
    await asyncio.sleep(0.1)
    import json as _json

    for _ in range(10):
        await redis.publish(
            COMMAND_CHANNEL,
            _json.dumps({"command": "reconnect", "tenant_id": "tenant-two", "connection_id": CONNECTION}),
        )
        await asyncio.sleep(0.02)
    await redis.publish(COMMAND_CHANNEL, "not-json")
    await asyncio.sleep(0.1)
    supervisor.stop.set()
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert not mine.reconnect.is_set()

def test_worker_never_calls_a_loop_driving_ib_method():
    import inspect
    import re
    from pathlib import Path

    import ib_async

    source = inspect.getsource(ib_async.IB)
    driving = {
        match.group(1)
        for match in re.finditer(
            r"\n    def (\w+)\(.*?(?=\n    (?:def |@|async def )|\Z)", source, re.S
        )
        if "self._run(" in match.group(0)
    }
    assert driving, "expected to find synchronous ib_async methods to guard against"

    worker = Path(inspect.getfile(GatewaySession)).read_text()
    called = set(re.findall(r"self\.ib\.(\w+)", worker))
    offenders = sorted(called & driving)
    assert not offenders, (
        f"worker.py calls blocking ib_async methods {offenders}; await the *Async variant instead"
    )

@pytest.mark.parametrize(
    "provider,expected",
    [("ibkr_gateway", "GatewaySession"), ("snaptrade", None), ("carrier-pigeon", None)],
)
async def test_build_session_picks_the_provider(stores, provider, expected):
    from app.worker import build_session

    redis, db = stores
    doc = {**gateway_connection(TENANT, CONNECTION, "Gateway", 4101), "provider": provider}
    built = build_session(redis, db, doc)
    assert (type(built).__name__ if built else None) == expected

async def test_farm_connecting_notice_does_not_degrade(stores):
    redis, db = stores
    worker = session(redis, db)
    worker.state.status = GatewayStatus.CONNECTED
    worker.state.subscriptions = {"accounts": "ACTIVE", "positions": "ACTIVE"}
    worker.broker_error(-1, 2119, "Market data farm is connecting:usopt", None)
    assert worker.state.status == GatewayStatus.CONNECTED
    assert worker.state.last_error is None
    assert worker.state.subscriptions == {"accounts": "ACTIVE", "positions": "ACTIVE"}
    assert not worker.fault.is_set()

async def test_a_broken_farm_degrades_until_it_reconnects(stores):
    redis, db = stores
    worker = session(redis, db)
    worker.state.status = GatewayStatus.CONNECTED
    worker.state.subscriptions = {"accounts": "ACTIVE", "positions": "ACTIVE"}
    worker.broker_error(-1, 2103, "Market data farm connection is broken:usopt", None)
    assert worker.state.status == GatewayStatus.DEGRADED
    assert worker.state.last_error.startswith("2103:")
    assert not worker.fault.is_set()
    worker.broker_error(-1, 2104, "Market data farm connection is OK:usopt", None)
    assert worker.state.status == GatewayStatus.CONNECTED
    assert worker.state.last_error is None
    assert worker.state.subscriptions == {"accounts": "ACTIVE", "positions": "ACTIVE"}

async def test_restored_connectivity_does_not_tear_down_the_session(stores):
    redis, db = stores
    worker = session(redis, db)
    worker.state.status = GatewayStatus.CONNECTED
    worker.state.subscriptions = {"accounts": "ACTIVE", "positions": "ACTIVE"}
    worker.broker_error(-1, 2103, "Market data farm connection is broken:usfarm", None)
    worker.broker_error(-1, 2104, "Market data farm connection is OK:usfarm", None)
    worker.broker_error(
        -1,
        1102,
        "Connectivity between IBKR and Trader Workstation has been restored - data maintained.",
        None,
    )
    assert not worker.fault.is_set()
    assert worker.state.status == GatewayStatus.CONNECTED
    assert worker.state.last_error is None
    assert worker.state.subscriptions == {"accounts": "ACTIVE", "positions": "ACTIVE"}

async def test_lost_connectivity_still_rebuilds_the_session(stores):
    redis, db = stores
    worker = session(redis, db)
    worker.state.status = GatewayStatus.CONNECTED
    worker.broker_error(-1, 1100, "Connectivity between IBKR and TWS has been lost.", None)
    assert worker.fault.is_set()
    assert worker.state.status == GatewayStatus.DEGRADED

async def test_a_farm_notice_does_not_clear_a_real_error(stores):
    redis, db = stores
    worker = session(redis, db)
    worker.broker_error(1, 201, "Order rejected", None)
    worker.broker_error(-1, 2104, "Market data farm connection is OK:usopt", None)
    assert worker.state.status == GatewayStatus.DEGRADED
    assert worker.state.last_error.startswith("201:")

def option(con_id, symbol="SPX", currency="USD"):
    contract = MagicMock()
    contract.conId, contract.symbol, contract.currency = con_id, symbol, currency
    return contract

def held(account="U1", con_id=1, quantity="1", symbol="SPX", currency="USD"):
    value = MagicMock()
    value.account, value.position, value.avgCost = account, quantity, "500"
    value.contract = option(con_id, symbol, currency)
    value.contract.localSymbol = f"{symbol} OPT"
    value.contract.secType = "OPT"
    value.contract.exchange = ""
    value.contract.lastTradeDateOrContractMonth = "20260918"
    value.contract.strike = 7500.0
    value.contract.right = "C"
    value.contract.multiplier = "100"
    return value

def tick(con_id, und_price, symbol="SPX", currency="USD"):
    ticker = MagicMock()
    ticker.contract = option(con_id, symbol, currency)
    ticker.modelGreeks.undPrice = und_price
    return ticker

def qualifying(ib):
    ib.qualifyContractsAsync = AsyncMock(side_effect=lambda contract: [contract])
    return ib

async def test_one_market_data_line_prices_the_whole_chain(stores):
    redis, db = stores
    ib = qualifying(MagicMock())
    worker = session(redis, db, ib)
    for con_id in (1, 2, 3):
        worker.position_value(held(con_id=con_id))
    assert ib.reqMktData.call_count == 0, "the callback must not dial IB itself"
    await worker.subscribe_underlyings()
    assert ib.reqMktData.call_count == 1
    assert list(worker.market_subscriptions) == ["USD:SPX"]

async def test_spx_uses_a_direct_index_market_data_line(stores):
    redis, db = stores
    ib = qualifying(MagicMock())
    worker = session(redis, db, ib)
    worker.position_value(held(con_id=1))
    assert worker.contracts[1].exchange == ""
    await worker.subscribe_underlyings()
    requested = ib.qualifyContractsAsync.call_args.args[0]
    assert requested.secType == "IND"
    assert requested.symbol == "SPX"
    assert requested.exchange == "CBOE"
    assert ib.reqMktData.call_args.args[0].secType == "IND"
    assert worker.contracts[1].exchange == "", "the stored contract must not be mutated"

async def test_an_unqualifiable_contract_is_dropped_not_retried(stores):
    redis, db = stores
    ib = MagicMock()
    ib.qualifyContractsAsync = AsyncMock(side_effect=ValueError("unknown contract"))
    worker = session(redis, db, ib)
    worker.position_value(held(con_id=1))
    await worker.subscribe_underlyings()
    ib.reqMktData.assert_not_called()
    assert not worker.market_wanted
    await worker.subscribe_underlyings()
    assert ib.qualifyContractsAsync.call_count == 1

async def test_underlying_price_reaches_positions(stores):
    redis, db = stores
    worker = session(redis, db, qualifying(MagicMock()))
    worker.position_value(held(con_id=1))
    assert worker.positions[("U1", 1)].underlying_price is None
    worker.ticker_value([tick(1, 7612.5)])
    assert worker.underlying_prices == {"USD:SPX": Decimal("7612.5")}
    worker.flush_underlyings()
    assert worker.positions[("U1", 1)].underlying_price == Decimal("7612.5")
    assert not worker.underlying_changed

async def test_direct_index_tick_is_selected_for_spx(stores):
    redis, db = stores
    worker = session(redis, db, qualifying(MagicMock()))
    ticker = MagicMock()
    ticker.contract.secType = "IND"
    ticker.contract.symbol = "SPX"
    ticker.contract.currency = "USD"
    ticker.modelGreeks = None
    ticker.marketPrice.return_value = 7673.13

    with patch.object(massive.settings, "massive_underlyings", "SPX"):
        worker.ticker_value([ticker])

    event = worker.queue.get_nowait()
    assert event.event_type == "underlying.sampled"
    assert event.data == {
        "currency": "USD",
        "symbol": "SPX",
        "price": "7673.13",
        "source": "ib_index_ltp",
    }
    worker.queue.task_done()

async def test_queued_position_event_is_stamped_with_latest_stored_spx(stores):
    redis, db = stores
    worker = session(redis, db, qualifying(MagicMock()))
    worker.position_value(held(con_id=1))
    await massive.record_sample(
        redis, "SPX", massive.Spot(Decimal("7673.13"), "ib_index_ltp")
    )
    worker.cached_prices["USD:SPX"] = await massive.last_spot(redis, "SPX")
    worker.live_underlyings.add("USD:SPX")

    with patch.object(massive.settings, "massive_underlyings", "SPX"):
        processor = asyncio.create_task(worker.process())
        await asyncio.wait_for(worker.queue.join(), 1)
        processor.cancel()
        await asyncio.gather(processor, return_exceptions=True)

    raw = await redis.hget(TenantKeys(TENANT).account_rows("U1", "positions"), "1")
    assert '"underlying_price": "7673.13"' in raw
    assert '"underlying_source": "ib_index_ltp"' in raw

async def test_an_unmoved_underlying_publishes_nothing(stores):
    redis, db = stores
    worker = session(redis, db, qualifying(MagicMock()))
    worker.position_value(held(con_id=1))
    worker.ticker_value([tick(1, 7612.5)])
    worker.flush_underlyings()
    before = worker.queue.qsize()
    worker.ticker_value([tick(1, 7612.5), tick(1, float("nan")), tick(1, 0)])
    worker.flush_underlyings()
    assert worker.queue.qsize() == before

async def test_the_market_data_line_moves_to_a_leg_that_is_still_open(stores):
    redis, db = stores
    ib = qualifying(MagicMock())
    worker = session(redis, db, ib)
    worker.position_value(held(con_id=1))
    worker.position_value(held(con_id=2))
    await worker.subscribe_underlyings()
    assert worker.market_wanted == {"USD:SPX": 1}
    worker.position_value(held(con_id=1, quantity="0"))
    assert ib.cancelMktData.call_count == 1
    assert worker.market_wanted == {"USD:SPX": 2}
    await worker.subscribe_underlyings()
    assert worker.market_subscriptions["USD:SPX"].secType == "IND"

async def test_a_denied_market_data_feed_does_not_degrade_the_gateway(stores):
    redis, db = stores
    ib = qualifying(MagicMock())
    worker = session(redis, db, ib)
    worker.state.status = GatewayStatus.CONNECTED
    worker.position_value(held(con_id=1))
    await worker.subscribe_underlyings()
    worker.broker_error(9, 354, "Requested market data is not subscribed.", None)
    assert worker.state.status == GatewayStatus.CONNECTED
    assert worker.state.last_error is None
    assert not worker.fault.is_set()
    assert worker.market_data_denied and not worker.market_subscriptions
    ib.reqMktData.reset_mock()
    worker.position_value(held(con_id=2))
    await worker.subscribe_underlyings()
    ib.reqMktData.assert_not_called()

async def test_a_request_error_on_our_own_market_data_line_spares_the_gateway(stores):
    redis, db = stores
    ib = qualifying(MagicMock())
    ib.wrapper.reqId2Ticker = {7: object()}
    worker = session(redis, db, ib)
    worker.state.status = GatewayStatus.CONNECTED
    worker.broker_error(7, 321, "Error validating request. cause - Please enter exchange", None)
    assert worker.state.status == GatewayStatus.CONNECTED
    assert worker.state.last_error is None
    assert not worker.fault.is_set()
    worker.broker_error(8, 321, "Error validating request. cause - Please enter exchange", None)
    assert worker.state.status == GatewayStatus.DEGRADED

async def test_ibkrs_aggregate_is_not_counted_as_an_account(stores):
\
\
\
\
\

    redis, db = stores
    worker = session(redis, db)
    assert worker.accept_account("U22050074") is True
    assert worker.accept_account("All") is False
    assert worker.accept_account("ALL") is False
    assert worker.accept_account("") is False
    assert worker.accept_account(None) is False

async def test_an_explicit_account_filter_still_wins(stores):
    redis, db = stores
    worker = session(redis, db)
    worker.account_filter = "U22050074"
    assert worker.accept_account("U22050074") is True
    assert worker.accept_account("U99999999") is False

    worker.account_filter = "All"
    assert worker.accept_account("All") is False
