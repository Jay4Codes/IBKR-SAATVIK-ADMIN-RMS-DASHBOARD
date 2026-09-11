"""The broker worker: one supervised session per enabled connection.

Before tenancy this process held a single IB Gateway session against a single
set of environment variables. It is now a *supervisor*: it watches
`broker_connections`, and for every enabled connection in an active tenant it
runs one session — an IB Gateway session over ib_async, or a SnapTrade polling
session — plus one durable MongoDB consumer per tenant.

Each session takes a Redis lease on its own connection key, so running two
worker processes is safe: the second finds the lease held and waits, and a
session that loses its lease stops touching the broker rather than racing.
"""

import asyncio
import contextlib
import copy
import json
import logging
import random
import signal
from decimal import Decimal
from uuid import uuid4

import httpx
from ib_async import IB, StartupFetch
from redis.asyncio import Redis
from redis.exceptions import ResponseError

from app import connections as registry
from app import massive, secrets, snaptrade
from app import normalizers as norm
from app.config import settings
from app.db import database, initialize, persist, snapshot_id
from app.domain import AccountState, Event, GatewayState, GatewayStatus, Position, now
from app.logging import configure
from app.state import StateRepository
from app.tenancy import COMMAND_CHANNEL, TenantKeys

log = logging.getLogger("ibkr-worker")

RENEW = "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('expire',KEYS[1],ARGV[2]) else return 0 end"
RELEASE = "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end"

#: How often the supervisor re-reads the connection registry.
SUPERVISE_INTERVAL = 10.0
LEASE_SECONDS = 20

#: Farm/connectivity notices IB emits in the 2100s. These are status chatter, not
#: faults: a farm that is connecting (2119) or idle (2107/2108) still serves the
#: account, position and order feeds this worker subscribes to.
BROKER_NOTICES = (2104, 2106, 2107, 2108, 2119, 2158)
#: A farm dropping out degrades the feed until its matching OK notice arrives.
BROKER_FARM_FAULTS = (2103, 2105, 2157)
#: Notices that clear an outstanding farm fault.
BROKER_FARM_RECOVERED = (2104, 2106, 2119, 2158)
#: Codes that mean the session itself is gone and must be rebuilt.
BROKER_FATAL = (1100, 1101, 1102, 1300, 326, 502, 504)
#: Market-data entitlement refusals. Accounts, positions and orders do not depend
#: on a market-data subscription, so these cost us the underlying mark and nothing
#: else: warn, stop asking, and leave the gateway healthy.
BROKER_MARKET_DATA = (354, 10089, 10090, 10091, 10167, 10168, 10197)


def backoff(attempt):
    return min(60, 2 ** min(attempt, 6)) + random.uniform(0, 1)


async def durable_consumer(redis, db, tenant_id: str, stop: asyncio.Event):
    """Drain one tenant's event stream into MongoDB, acknowledging only on success.

    Entries are acknowledged after the write, so a crash between the two replays
    the entry rather than losing it; every write in `persist` is idempotent.
    """
    keys = TenantKeys(tenant_id)
    group = keys.consumer_group
    try:
        await redis.xgroup_create(keys.events, group, id="0-0", mkstream=True)
    except ResponseError as exc:
        if "BUSYGROUP" not in str(exc):
            raise
    pending = True
    while not stop.is_set():
        try:
            batches = await redis.xreadgroup(
                group, "primary", {keys.events: "0" if pending else ">"}, count=100, block=1000
            )
            if not batches or not batches[0][1]:
                pending = False
                await asyncio.sleep(0.05)
                continue
            for _, entries in batches:
                for event_id, fields in entries:
                    await persist(
                        db,
                        Event.model_validate_json(fields["event"]),
                        tenant_id=tenant_id,
                        connection_id=fields.get("connection_id", ""),
                    )
                    await redis.xack(keys.events, group, event_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("history.persistence_failed tenant=%s", tenant_id)
            pending = True
            await asyncio.sleep(2)


class Session:
    """Common lease, command, and shutdown handling for any broker session."""

    def __init__(self, redis, db, tenant_id: str, connection: dict):
        self.redis, self.db = redis, db
        self.tenant_id = tenant_id
        self.connection = connection
        self.connection_id = connection["_id"]
        self.keys = TenantKeys(tenant_id)
        self.repo = StateRepository(redis, tenant_id, self.connection_id)
        self.stop = asyncio.Event()
        self.reconnect = asyncio.Event()
        self.token = str(uuid4())
        #: Set by the supervisor; a change means this session must be rebuilt.
        self.fingerprint = ""

    @property
    def label(self) -> str:
        return f"{self.tenant_id}/{self.connection.get('name') or self.connection_id}"

    async def renew(self):
        while True:
            await asyncio.sleep(5)
            if not await self.redis.eval(
                RENEW, 1, self.keys.lease(self.connection_id), self.token, LEASE_SECONDS
            ):
                raise RuntimeError("Session lease lost; stopping broker session")

    async def acquire(self) -> bool:
        return bool(
            await self.redis.set(
                self.keys.lease(self.connection_id), self.token, nx=True, ex=LEASE_SECONDS
            )
        )

    async def release(self):
        with contextlib.suppress(Exception):
            await self.redis.eval(RELEASE, 1, self.keys.lease(self.connection_id), self.token)

    def command(self, message: dict):
        """Route one operator command. Called by the supervisor's subscriber."""
        if message.get("command") == "reconnect":
            log.info("command.reconnect_requested connection=%s", self.label)
            self.reconnect.set()
            self.on_reconnect()

    def on_reconnect(self):
        """Hook for a session that must interrupt an in-flight broker call."""


class GatewaySession(Session):
    """An IB Gateway session: subscriptions, snapshots, and reconnection."""

    def __init__(self, redis, db, tenant_id: str, connection: dict, ib=None):
        super().__init__(redis, db, tenant_id, connection)
        self.ib = ib or IB()
        self.ib.RaiseRequestErrors = True
        self.fault = asyncio.Event()
        self.queue = asyncio.Queue(maxsize=20000)
        self.accounts = {}
        self.positions = {}
        self.pnl_subscriptions = set()
        self.execution_versions = {}
        self.order_versions = {}
        self.account_filter = (connection.get("account_filter") or "").strip()
        self.farm_fault = None
        self.contracts = {}
        self.market_wanted = {}
        self.market_subscriptions = {}
        self.market_data_denied = False
        self.underlying_prices = {}
        #: Vendor marks as `massive.Spot`, held apart from IB's so a gateway
        #: reconnect cannot wipe them and an option model tick cannot overwrite
        #: them. `underlying_of` prefers these.
        self.massive_prices = {}
        self.underlying_changed = set()
        self.state = GatewayState(
            gateway_id=self.connection_id,
            host=connection.get("host") or "127.0.0.1",
            port=int(connection.get("api_port") or 0),
            client_id=int(connection.get("client_id") or settings.ibkr_client_id),
        )

    def on_reconnect(self):
        self.fault.set()

    def enqueue(self, kind, value):
        try:
            self.queue.put_nowait(
                Event(event_type=kind, account_id=value.account_id, data=value.model_dump(mode="json"))
            )
        except Exception:
            log.exception("callback.queue_failed connection=%s", self.label)
            self.fault.set()

    def callback(self, function):
        def guarded(*args):
            try:
                function(*args)
            except Exception as exc:
                log.exception("callback.normalization_failed connection=%s", self.label)
                self.state.last_error = str(exc)
                self.fault.set()

        return guarded

    async def publish_gateway(self, status=None):
        old = self.state.status
        if status:
            self.state.status = status
        if status == GatewayStatus.CONNECTED and old != status:
            self.state.connected_at = now()
        if status == GatewayStatus.DISCONNECTED:
            self.state.disconnected_at = now()
            self.state.subscriptions = {key: "INACTIVE" for key in self.state.subscriptions}
        kind = (
            "gateway.connected"
            if status == GatewayStatus.CONNECTED and old != status
            else ("gateway.disconnected" if status == GatewayStatus.DISCONNECTED else "gateway.updated")
        )
        if status and old != status:
            log.info("gateway.state_changed connection=%s status=%s", self.label, status)
        await self.repo.publish(
            Event(event_type=kind, account_id="*", data=self.state.model_dump(mode="json"))
        )

    def accept_account(self, account):
        return bool(account) and (not self.account_filter or self.account_filter == account)

    def account_value(self, value):
        if not self.accept_account(value.account):
            return
        account = self.accounts.setdefault(value.account, AccountState(account_id=value.account))
        if value.tag == "NetLiquidation" and value.currency not in ("", "BASE"):
            account.currency = value.currency
        if value.tag == "Currency" and value.value:
            account.currency = value.value
        field = norm.ACCOUNT_TAGS.get(value.tag)
        if field and value.currency in ("", "BASE", account.currency):
            setattr(account, field, norm.decimal(value.value))
            account.updated_at = now()
            self.enqueue("account.updated", account)

    def position_value(self, value, is_portfolio=False):
        if not self.accept_account(value.account):
            return
        item = norm.portfolio(value) if is_portfolio else norm.position(value)
        key = (item.account_id, item.con_id)
        previous = self.positions.get(key)
        if previous and not is_portfolio:
            item = previous.model_copy(
                update={"quantity": item.quantity, "average_cost": item.average_cost, "updated_at": now()}
            )
        item.quantity_changed = previous is None or previous.quantity != item.quantity
        item.underlying_price = self.underlying_of(item)
        item.underlying_source = self.underlying_source_of(item)
        self.positions[key] = item
        self.track_underlying(item, value.contract)
        self.enqueue("position.closed" if item.quantity == 0 else "position.updated", item)
        if item.quantity != 0 and key not in self.pnl_subscriptions:
            self.ib.reqPnLSingle(item.account_id, "", item.con_id)
            self.pnl_subscriptions.add(key)
        elif item.quantity == 0 and key in self.pnl_subscriptions:
            self.ib.cancelPnLSingle(item.account_id, "", item.con_id)
            self.pnl_subscriptions.remove(key)

    def position_pnl(self, value):
        item = self.positions.get((value.account, value.conId))
        if not item:
            return
        account = self.accounts.get(value.account)
        if not account or item.currency != account.currency:
            return
        item = item.model_copy(
            update={
                "quantity_changed": False,
                "underlying_price": self.underlying_of(item),
                "underlying_source": self.underlying_source_of(item),
                "market_value": norm.decimal(value.value),
                "unrealized_pnl": norm.decimal(value.unrealizedPnL),
                "realized_pnl": norm.decimal(value.realizedPnL),
                "updated_at": now(),
            }
        )
        if item.market_value is not None and item.quantity:
            item.market_price = item.market_value / (item.quantity * (item.multiplier or Decimal(1)))
        self.positions[(value.account, value.conId)] = item
        self.enqueue("position.closed" if item.quantity == 0 else "position.updated", item)

    def account_pnl(self, value):
        if value.account not in self.accounts:
            return
        item = self.accounts[value.account]
        item.day_pnl, item.realized_pnl, item.unrealized_pnl = (
            norm.decimal(value.dailyPnL),
            norm.decimal(value.realizedPnL),
            norm.decimal(value.unrealizedPnL),
        )
        item.updated_at = now()
        self.enqueue("account.updated", item)

    def underlying_key(self, item):
        return f"{item.currency}:{item.symbol}"

    def underlying_of(self, item):
        """The live underlying mark for an option, or None for anything else.

        Massive wins when it has a quote; IB's option-model `undPrice` keeps the
        RMS curve available when the vendor is unavailable or unauthorized.
        """
        if item.sec_type != "OPT":
            return None
        key = self.underlying_key(item)
        vendor = self.massive_prices.get(key)
        return vendor.price if vendor is not None else self.underlying_prices.get(key)

    def underlying_source_of(self, item) -> str:
        """Which feed `underlying_of` would answer from, for the panel's label."""
        if item.sec_type != "OPT":
            return ""
        key = self.underlying_key(item)
        vendor = self.massive_prices.get(key)
        if vendor is not None:
            return vendor.source
        return "ib_und_price" if key in self.underlying_prices else ""

    def track_underlying(self, item, contract):
        """Note which leg should carry an underlying's market-data line.

        IB's option model tick carries `undPrice`, so one subscribed contract
        prices the whole chain: six SPX legs need one line, not six. Opening it
        needs an await, so this callback only records the intent and
        `subscribe_underlyings` acts on it from the loop.
        """
        if item.sec_type != "OPT" or self.market_data_denied or not contract:
            return
        key = self.underlying_key(item)
        self.contracts[item.con_id] = contract
        if item.quantity != 0:
            self.market_wanted.setdefault(key, item.con_id)
            return
        if self.market_wanted.get(key) == item.con_id:
            del self.market_wanted[key]
        if (subscribed := self.market_subscriptions.pop(key, None)) is not None:
            self.ib.cancelMktData(subscribed)
        # Hand the line to another leg on the same underlying, if one is open.
        for other in self.positions.values():
            if (
                other.sec_type == "OPT"
                and other.quantity != 0
                and self.underlying_key(other) == key
                and other.con_id in self.contracts
            ):
                self.market_wanted.setdefault(key, other.con_id)
                return

    async def spot(self):
        """Poll Massive for the configured underlyings until the session stops.

        Runs beside `live` rather than inside it: the vendor feed has nothing to
        do with the IB socket, so it keeps its marks across a reconnect. Moved
        prices are queued onto `underlying_changed`, and the heartbeat loop's
        existing `flush_underlyings` publishes them on its next pass.
        """
        symbols = settings.massive_symbols
        if not symbols:
            await self.stop.wait()  # Unconfigured, but `run` waits on the first task to finish.
            return
        async with httpx.AsyncClient(timeout=10) as client:
            while not self.stop.is_set():
                moment = now()
                for symbol in symbols:
                    try:
                        archived = await massive.archive_due_samples(
                            self.redis, symbol, at=moment
                        )
                        key = f"USD:{symbol}"
                        if archived and self.massive_prices.pop(key, None) is not None:
                            # Do not carry yesterday's close as today's live RMS
                            # reference while waiting for the next session.
                            self.underlying_changed.add(key)
                    except Exception:
                        # The source list remains/restores on failure, so the
                        # next idle pass can safely retry the archive.
                        log.exception("massive.archive_failed symbol=%s", symbol)
                if not settings.massive_api_key or not massive.session_is_open(moment):
                    with contextlib.suppress(TimeoutError):
                        await asyncio.wait_for(
                            self.stop.wait(), settings.massive_idle_seconds
                        )
                    continue
                answered = False
                limited = False
                for symbol in symbols:
                    try:
                        spot = await massive.fetch_spot(client, symbol)
                    except massive.RateLimited as exc:
                        # Quota is per minute and shared across symbols, so the
                        # rest of this cycle would only deepen the hole.
                        log.warning("massive.rate_limited connection=%s path=%s", self.label, exc)
                        limited = True
                        break
                    if spot is None:
                        continue
                    answered = True
                    try:
                        await massive.record_sample(self.redis, symbol, spot, at=moment)
                    except Exception:
                        log.exception("massive.sample_store_failed symbol=%s", symbol)
                    key = f"USD:{symbol}"
                    if getattr(self.massive_prices.get(key), "price", None) != spot.price:
                        self.massive_prices[key] = spot
                        self.underlying_changed.add(key)
                        log.debug(
                            "massive.spot connection=%s underlying=%s price=%s source=%s",
                            self.label,
                            key,
                            spot.price,
                            spot.source,
                        )
                if not answered and not limited:
                    log.warning(
                        "massive.no_prices connection=%s underlyings=%s backing off to %ss",
                        self.label,
                        ",".join(symbols),
                        settings.massive_idle_seconds,
                    )
                delay = (
                    settings.massive_refresh_seconds if answered else settings.massive_idle_seconds
                )
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self.stop.wait(), delay)

    async def snapshots(self):
        """Record each account's standing every `snapshot_seconds`.

        This is the only record of what an account was worth at a moment in
        time: `ibkr_accounts` is replaced in place on every update, so without
        this there is no history to plot. Rows are keyed by account and date
        plus a within-day bucket, so a restart re-samples rather than
        duplicating, and a later Flex backfill can supersede the whole day.
        """
        interval = max(30.0, settings.snapshot_seconds)
        while not self.stop.is_set():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self.stop.wait(), interval)
            if self.stop.is_set():
                return
            moment = now()
            report_date = moment.date().isoformat()
            bucket = moment.strftime("%H%M")
            for account in list(self.accounts.values()):
                if account.net_liquidation is None:
                    continue  # Nothing worth plotting until the broker has valued it.
                try:
                    await self.db.account_snapshots.update_one(
                        {"_id": snapshot_id(self.tenant_id, account.account_id, report_date, bucket)},
                        {
                            "$set": {
                                "tenant_id": self.tenant_id,
                                "account_id": account.account_id,
                                "report_date": report_date,
                                "taken_at": moment.isoformat(),
                                "currency": account.currency,
                                "net_liquidation": str(account.net_liquidation),
                                "cash": None if account.cash is None else str(account.cash),
                                # The broker's own daily figure, which resets at
                                # its session boundary — the only way to draw an
                                # intraday P&L curve after the fact.
                                "day_pnl": None if account.day_pnl is None else str(account.day_pnl),
                                "realized_pnl": None
                                if account.realized_pnl is None
                                else str(account.realized_pnl),
                                "unrealized_pnl": None
                                if account.unrealized_pnl is None
                                else str(account.unrealized_pnl),
                                "source": "snapshot",
                            }
                        },
                        upsert=True,
                    )
                except Exception:
                    log.exception("snapshot.write_failed connection=%s account=%s",
                                  self.label, account.account_id)

    async def subscribe_underlyings(self):
        """Open the market-data lines `track_underlying` asked for.

        Position events name a contract but no exchange, and `reqMktData` refuses
        one without it (error 321), so each contract is qualified first.
        """
        for key, con_id in list(self.market_wanted.items()):
            if self.market_data_denied:
                return
            if key in self.market_subscriptions or con_id not in self.contracts:
                continue
            wanted = copy.copy(self.contracts[con_id])
            wanted.exchange = wanted.exchange or "SMART"
            try:
                qualified = await asyncio.wait_for(
                    self.ib.qualifyContractsAsync(wanted), settings.connection_timeout
                )
            except Exception as exc:
                qualified, error = [], exc
            else:
                error = None
            if not qualified:
                log.warning(
                    "broker.underlying_unqualified connection=%s underlying=%s con_id=%s error=%s",
                    self.label,
                    key,
                    con_id,
                    error,
                )
                del self.market_wanted[key]
                continue
            self.market_subscriptions[key] = qualified[0]
            self.ib.reqMktData(qualified[0])

    def stop_market_data(self):
        """Drop every market-data line: the account is not entitled to the feed."""
        self.market_data_denied = True
        for contract in self.market_subscriptions.values():
            self.ib.cancelMktData(contract)
        self.market_subscriptions.clear()
        self.market_wanted.clear()

    def ticker_value(self, tickers):
        """Record `undPrice` off the option model ticks; publishing is batched."""
        for ticker in tickers:
            greeks, contract = ticker.modelGreeks, ticker.contract
            price = norm.decimal(getattr(greeks, "undPrice", None)) if greeks else None
            if price is None or price <= 0 or contract is None:
                continue
            key = f"{contract.currency}:{contract.symbol}"
            if self.underlying_prices.get(key) != price:
                self.underlying_prices[key] = price
                self.underlying_changed.add(key)

    def flush_underlyings(self):
        """Publish a moved underlying mark even when no P&L update follows it."""
        if not self.underlying_changed:
            return
        keys, self.underlying_changed = self.underlying_changed, set()
        for key, item in list(self.positions.items()):
            price = self.underlying_of(item)
            if self.underlying_key(item) in keys and item.quantity != 0 and item.underlying_price != price:
                item = item.model_copy(
                    update={
                        "quantity_changed": False,
                        "underlying_price": price,
                        "underlying_source": self.underlying_source_of(item),
                        "updated_at": now(),
                    }
                )
                self.positions[key] = item
                self.enqueue("position.updated", item)

    def order_value(self, trade):
        if not self.accept_account(trade.order.account):
            log.warning(
                "order.unassigned_or_filtered connection=%s account=%s perm_id=%s",
                self.label,
                trade.order.account,
                trade.order.permId,
            )
            return
        item = norm.order(trade)
        version = item.model_dump_json(exclude={"created_at", "updated_at"})
        if self.order_versions.get(item.key) == version:
            return
        self.order_versions[item.key] = version
        kind = (
            "order.filled"
            if item.status == "Filled"
            else ("order.cancelled" if item.status in ("Cancelled", "ApiCancelled") else "order.updated")
        )
        self.enqueue(kind, item)

    def fill_value(self, trade, fill, *args):
        item = norm.execution(fill)
        if self.accept_account(item.account_id):
            version = item.model_dump_json()
            if self.execution_versions.get(item.execution_id) != version:
                self.enqueue("execution.created", item)
                self.execution_versions[item.execution_id] = version

    def broker_error(self, req_id, code, message, contract):
        if code in BROKER_MARKET_DATA or req_id in getattr(self.ib.wrapper, "reqId2Ticker", {}):
            log.warning(
                "broker.market_data_unavailable connection=%s code=%s message=%s", self.label, code, message
            )
            self.stop_market_data()
            return
        if code in BROKER_NOTICES:
            log.info("broker.notice connection=%s code=%s message=%s", self.label, code, message)
            if code in BROKER_FARM_RECOVERED:
                self.farm_recovered()
            return
        log.error(
            "broker.error connection=%s code=%s request=%s message=%s", self.label, code, req_id, message
        )
        self.state.last_error = f"{code}: {message}"
        self.state.status = GatewayStatus.DEGRADED
        self.state.subscriptions = {key: "DEGRADED" for key in self.state.subscriptions}
        if code in BROKER_FARM_FAULTS:
            self.farm_fault = code
        if code in BROKER_FATAL:
            self.fault.set()

    def farm_recovered(self):
        """Undo a farm-fault degrade once IB reports the farm back.

        Only a degrade this worker raised from a farm fault is cleared: anything
        else that set `last_error` is a real problem the reconnect loop owns.
        """
        if not self.farm_fault:
            return
        self.farm_fault = None
        self.state.last_error = None
        if self.state.status == GatewayStatus.DEGRADED:
            self.state.status = GatewayStatus.CONNECTED
        self.state.subscriptions = {
            key: ("ACTIVE" if value == "DEGRADED" else value)
            for key, value in self.state.subscriptions.items()
        }

    def bind(self):
        bindings = [
            (self.ib.accountValueEvent, self.account_value),
            (self.ib.accountSummaryEvent, self.account_value),
            (self.ib.positionEvent, self.position_value),
            (self.ib.updatePortfolioEvent, lambda item: self.position_value(item, True)),
            (self.ib.pnlEvent, self.account_pnl),
            (self.ib.pnlSingleEvent, self.position_pnl),
            (self.ib.openOrderEvent, self.order_value),
            (self.ib.orderStatusEvent, self.order_value),
            (self.ib.pendingTickersEvent, self.ticker_value),
            (self.ib.execDetailsEvent, self.fill_value),
            (self.ib.commissionReportEvent, self.fill_value),
            (self.ib.errorEvent, self.broker_error),
        ]
        for event, callback in bindings:
            event += self.callback(callback)
        self.ib.disconnectedEvent += self.fault.set

    async def process(self):
        while True:
            event = await self.queue.get()
            try:
                await self.repo.publish(event)
            finally:
                self.queue.task_done()

    async def sync(self):
        accounts = [a for a in self.ib.managedAccounts() if self.accept_account(a)]
        if not accounts:
            raise RuntimeError("API username has no accessible configured accounts")
        for account in accounts:
            self.accounts[account] = AccountState(account_id=account)
            await asyncio.wait_for(self.ib.reqAccountUpdatesMultiAsync(account), settings.connection_timeout)
            self.ib.reqPnL(account)
        await asyncio.wait_for(self.ib.reqAccountSummaryAsync(), settings.connection_timeout)
        for value in self.ib.accountValues():
            self.account_value(value)
        for value in await self.ib.accountSummaryAsync():
            self.account_value(value)
        for account in self.accounts.values():
            self.enqueue("account.updated", account)
        for value in self.ib.positions():
            self.position_value(value)
        await self.subscribe_underlyings()
        await self.poll_orders()
        for fill in await asyncio.wait_for(self.ib.reqExecutionsAsync(), settings.connection_timeout):
            self.fill_value(None, fill)
        for account in accounts:
            current = {v.contract.conId for v in self.ib.positions(account) if v.position}
            for old in await self.repo.rows(account, "positions"):
                if old["con_id"] not in current:
                    closed = Position.model_validate(old).model_copy(
                        update={"quantity": Decimal(0), "updated_at": now()}
                    )
                    self.enqueue("position.closed", closed)
        await self.queue.put(
            Event(event_type="accounts.reconciled", account_id="*", data={"accounts": accounts})
        )
        self.state.subscriptions = {
            "accounts": "ACTIVE",
            "positions": "ACTIVE",
            "orders": "ACTIVE",
            "executions": "ACTIVE",
        }

    async def poll_orders(self):
        trades = await asyncio.wait_for(self.ib.reqAllOpenOrdersAsync(), settings.connection_timeout)
        for trade in trades:
            self.order_value(trade)
        by_account = {a: [] for a in self.accounts}
        for trade in trades:
            if trade.order.account in by_account:
                by_account[trade.order.account].append(norm.order(trade).model_dump(mode="json"))
        self.state.last_order_snapshot = now()
        for account, orders in by_account.items():
            await self.queue.put(
                Event(event_type="orders.reconciled", account_id=account, data={"orders": orders})
            )

    async def target(self):
        """Where to connect: a runtime override if one is set, else the connection."""
        chosen = await self.repo.target(self.connection_id)
        host = chosen.get("host") or self.connection.get("host") or "127.0.0.1"
        port = int(chosen.get("port") or self.connection.get("api_port") or 0)
        client_id = int(
            chosen.get("client_id") or self.connection.get("client_id") or settings.ibkr_client_id
        )
        self.state.host, self.state.port, self.state.client_id = host, port, client_id
        return host, port, client_id

    async def live(self):
        self.bind()
        attempts = 0
        failures = 0
        while not self.stop.is_set():
            try:
                self.fault.clear()
                manual = self.reconnect.is_set()
                self.reconnect.clear()
                if manual:
                    attempts = failures = 0
                host, port, client_id = await self.target()
                if client_id == 0:
                    raise ValueError("Use a nonzero client ID: client 0 automatically binds manual orders")
                if not port:
                    raise ValueError("This connection has no API port; provision it first")
                self.pnl_subscriptions.clear()
                self.contracts.clear()
                self.market_wanted.clear()
                self.market_subscriptions.clear()
                self.market_data_denied = False
                self.underlying_prices.clear()
                self.underlying_changed.clear()
                self.accounts.clear()
                self.positions.clear()
                self.order_versions.clear()
                self.state.reconnect_attempts = attempts
                self.state.last_error = None
                self.farm_fault = None
                await self.publish_gateway(
                    GatewayStatus.RECONNECTING if attempts else GatewayStatus.CONNECTING
                )
                await asyncio.wait_for(
                    self.ib.connectAsync(
                        host,
                        port,
                        clientId=client_id,
                        timeout=settings.connection_timeout,
                        readonly=True,
                        account=self.account_filter,
                        raiseSyncErrors=True,
                        fetchFields=StartupFetch(0),
                    ),
                    settings.connection_timeout + 2,
                )
                self.state.connected_at = now()
                await self.sync()
                if self.fault.is_set():
                    raise ConnectionError(self.state.last_error or "Subscription synchronization failed")
                self.state.last_heartbeat = now()
                await self.publish_gateway(
                    GatewayStatus.DEGRADED if self.state.last_error else GatewayStatus.CONNECTED
                )
                while not self.stop.is_set() and not self.fault.is_set():
                    await asyncio.wait_for(self.ib.reqCurrentTimeAsync(), settings.connection_timeout)
                    self.state.last_heartbeat = now()
                    if (now() - self.state.connected_at).total_seconds() >= 60:
                        failures = 0
                    await self.publish_gateway()
                    await self.subscribe_underlyings()
                    self.flush_underlyings()
                    await self.poll_orders()
                    for fill in await asyncio.wait_for(
                        self.ib.reqExecutionsAsync(), settings.connection_timeout
                    ):
                        self.fill_value(None, fill)
                    try:
                        await asyncio.wait_for(self.fault.wait(), settings.heartbeat_seconds)
                    except TimeoutError:
                        pass
                if self.fault.is_set():
                    raise ConnectionError("Gateway disconnected or broker synchronization fault")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.exception("gateway.connection_failed connection=%s", self.label)
                self.state.last_error = str(exc)
                attempts += 1
                failures += 1
                self.state.reconnect_attempts = attempts
                await self.publish_gateway(GatewayStatus.DISCONNECTED)
                await self.publish_gateway(
                    GatewayStatus.FAILED if failures >= 10 else GatewayStatus.RECONNECTING
                )
            finally:
                self.ib.disconnect()
            if not self.stop.is_set() and not self.reconnect.is_set():
                waiters = [
                    asyncio.create_task(self.stop.wait()),
                    asyncio.create_task(self.reconnect.wait()),
                ]
                try:
                    await asyncio.wait(waiters, timeout=backoff(failures), return_when=asyncio.FIRST_COMPLETED)
                finally:
                    for waiter in waiters:
                        waiter.cancel()

    async def run(self):
        if not await self.acquire():
            log.info("gateway.lease_held_elsewhere connection=%s", self.label)
            return
        tasks = []
        try:
            tasks = [
                asyncio.create_task(self.renew()),
                asyncio.create_task(self.process()),
                asyncio.create_task(self.live()),
                asyncio.create_task(self.spot()),
                asyncio.create_task(self.snapshots()),
                asyncio.create_task(self.stop.wait()),
            ]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        finally:
            self.ib.disconnect()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            try:
                if await self.redis.get(self.keys.lease(self.connection_id)) == self.token:
                    await self.publish_gateway(GatewayStatus.DISCONNECTED)
                    await self.release()
            except Exception:
                log.exception("gateway.shutdown_failed connection=%s", self.label)


class SnapTradeSession(Session):
    """A SnapTrade connection, refreshed on an interval.

    SnapTrade exposes no streaming socket, so this reports CONNECTED while polls
    succeed and DEGRADED once one fails, and emits the same domain events an IB
    Gateway session does — the dashboard cannot tell the two apart.
    """

    def __init__(self, redis, db, tenant_id: str, connection: dict):
        super().__init__(redis, db, tenant_id, connection)
        self.state = GatewayState(
            gateway_id=self.connection_id,
            host="snaptrade",
            port=0,
            client_id=0,
        )

    async def publish_gateway(self, status: GatewayStatus, error: str | None = None):
        self.state.status = status
        self.state.last_error = error
        self.state.last_heartbeat = now()
        if status == GatewayStatus.CONNECTED and not self.state.connected_at:
            self.state.connected_at = now()
        await self.repo.publish(
            Event(event_type="gateway.updated", account_id="*", data=self.state.model_dump(mode="json"))
        )

    async def refresh(self, client: snaptrade.SnapTradeClient):
        accounts = await client.accounts()
        seen: list[str] = []
        for row in accounts:
            account_id = str(row.get("number") or row.get("id") or "")
            if not account_id:
                continue
            seen.append(account_id)
            remote_id = str(row.get("id"))
            balances = await client.balances(remote_id)
            state = snaptrade.normalize_account(row, balances)
            await self.repo.publish(
                Event(
                    event_type="account.updated",
                    account_id=account_id,
                    data=state.model_dump(mode="json"),
                )
            )
            for index, position in enumerate(await client.positions(remote_id)):
                item = snaptrade.normalize_position(account_id, position)
                await self.repo.publish(
                    Event(
                        event_type="position.closed" if item.quantity == 0 else "position.updated",
                        account_id=account_id,
                        data=item.model_dump(mode="json"),
                    )
                )
            orders = [
                snaptrade.normalize_order(account_id, row, index)
                for index, row in enumerate(await client.orders(remote_id))
            ]
            await self.repo.publish(
                Event(
                    event_type="orders.reconciled",
                    account_id=account_id,
                    data={"orders": [o.model_dump(mode="json") for o in orders]},
                )
            )
            for activity in await client.activities(remote_id):
                fill = snaptrade.normalize_activity(account_id, activity)
                if fill and fill.execution_id:
                    await self.repo.publish(
                        Event(
                            event_type="execution.created",
                            account_id=account_id,
                            data=fill.model_dump(mode="json"),
                        )
                    )
        await self.repo.publish(
            Event(event_type="accounts.reconciled", account_id="*", data={"accounts": seen})
        )
        self.state.subscriptions = {
            "accounts": "ACTIVE",
            "positions": "ACTIVE",
            "orders": "ACTIVE",
            "executions": "ACTIVE",
        }

    async def poll(self):
        secret = self.connection.get("snaptrade_user_secret")
        failures = 0
        while not self.stop.is_set():
            try:
                self.reconnect.clear()
                async with snaptrade.SnapTradeClient(
                    self.connection.get("snaptrade_user_id"), secrets.decrypt(secret) if secret else None
                ) as client:
                    await self.refresh(client)
                failures = 0
                await self.publish_gateway(GatewayStatus.CONNECTED)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                failures += 1
                log.exception("snaptrade.poll_failed connection=%s", self.label)
                self.state.reconnect_attempts = failures
                await self.publish_gateway(
                    GatewayStatus.FAILED if failures >= 10 else GatewayStatus.DEGRADED, str(exc)
                )
            waiters = [
                asyncio.create_task(self.stop.wait()),
                asyncio.create_task(self.reconnect.wait()),
            ]
            try:
                await asyncio.wait(
                    waiters,
                    timeout=settings.snaptrade_poll_seconds if not failures else backoff(failures),
                    return_when=asyncio.FIRST_COMPLETED,
                )
            finally:
                for waiter in waiters:
                    waiter.cancel()

    async def run(self):
        if not await self.acquire():
            log.info("snaptrade.lease_held_elsewhere connection=%s", self.label)
            return
        tasks = []
        try:
            tasks = [
                asyncio.create_task(self.renew()),
                asyncio.create_task(self.poll()),
                asyncio.create_task(self.stop.wait()),
            ]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            with contextlib.suppress(Exception):
                await self.publish_gateway(GatewayStatus.DISCONNECTED)
            await self.release()


def build_session(redis, db, connection: dict) -> Session | None:
    provider = connection.get("provider")
    tenant_id = connection["tenant_id"]
    if provider == registry.Provider.IBKR_GATEWAY.value:
        return GatewaySession(redis, db, tenant_id, connection)
    if provider == registry.Provider.SNAPTRADE.value:
        if not snaptrade.configured():
            log.warning("snaptrade.not_configured connection=%s", connection["_id"])
            return None
        return SnapTradeSession(redis, db, tenant_id, connection)
    log.warning("connection.unsupported_provider provider=%s", provider)
    return None


class Supervisor:
    """Keeps the running sessions in step with the connection registry."""

    def __init__(self, redis, db):
        self.redis, self.db = redis, db
        self.stop = asyncio.Event()
        self.sessions: dict[str, tuple[Session, asyncio.Task]] = {}
        self.consumers: dict[str, tuple[asyncio.Event, asyncio.Task]] = {}

    def fingerprint(self, doc: dict) -> str:
        """What a session must be restarted for. A rename alone is not enough."""
        return json.dumps(
            {
                key: doc.get(key)
                for key in (
                    "provider",
                    "status",
                    "host",
                    "api_port",
                    "client_id",
                    "account_filter",
                    "snaptrade_user_id",
                    "snaptrade_user_secret",
                )
            },
            sort_keys=True,
            default=str,
        )

    async def reconcile(self):
        wanted = {doc["_id"]: doc for doc in await registry.supervised(self.db)}

        for connection_id, (session, task) in list(self.sessions.items()):
            doc = wanted.get(connection_id)
            if doc is None or self.fingerprint(doc) != session.fingerprint or task.done():
                log.info("supervisor.stopping connection=%s", session.label)
                session.stop.set()
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                del self.sessions[connection_id]

        for connection_id, doc in wanted.items():
            if connection_id in self.sessions:
                continue
            session = build_session(self.redis, self.db, doc)
            if session is None:
                continue
            session.fingerprint = self.fingerprint(doc)
            log.info("supervisor.starting connection=%s", session.label)
            self.sessions[connection_id] = (session, asyncio.create_task(session.run()))

        # One durable MongoDB consumer per tenant that has any live session.
        tenants = {doc["tenant_id"] for doc in wanted.values()}
        for tenant_id in tenants - set(self.consumers):
            stop = asyncio.Event()
            self.consumers[tenant_id] = (
                stop,
                asyncio.create_task(durable_consumer(self.redis, self.db, tenant_id, stop)),
            )
        for tenant_id in set(self.consumers) - tenants:
            stop, task = self.consumers.pop(tenant_id)
            stop.set()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def commands(self):
        """Fan operator commands out to the session they name."""
        pubsub = self.redis.pubsub()
        await pubsub.subscribe(COMMAND_CHANNEL)
        try:
            while not self.stop.is_set():
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1)
                if not message:
                    continue
                try:
                    payload = json.loads(message["data"])
                except Exception:
                    log.exception("command.malformed")
                    continue
                entry = self.sessions.get(payload.get("connection_id", ""))
                if not entry:
                    log.info("command.no_session connection=%s", payload.get("connection_id"))
                    continue
                session, _ = entry
                if session.tenant_id != payload.get("tenant_id"):
                    log.warning("command.tenant_mismatch connection=%s", payload.get("connection_id"))
                    continue
                session.command(payload)
        finally:
            await pubsub.aclose()

    async def supervise(self):
        while not self.stop.is_set():
            try:
                await self.reconcile()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("supervisor.reconcile_failed")
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self.stop.wait(), SUPERVISE_INTERVAL)

    async def run(self):
        tasks = [
            asyncio.create_task(self.supervise()),
            asyncio.create_task(self.commands()),
            asyncio.create_task(self.stop.wait()),
        ]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        finally:
            for session, task in self.sessions.values():
                session.stop.set()
                task.cancel()
            for _, (stop, task) in self.consumers.items():
                stop.set()
                task.cancel()
            everything = [t for _, t in self.sessions.values()] + [t for _, t in self.consumers.values()]
            await asyncio.gather(*everything, *tasks, return_exceptions=True)


async def main():
    configure()
    client, db = database()
    redis = Redis.from_url(settings.redis_url, decode_responses=True)
    supervisor = Supervisor(redis, db)
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, supervisor.stop.set)
    try:
        await initialize(db)
        await supervisor.run()
    finally:
        await redis.aclose()
        await client.close()


if __name__ == "__main__":
    asyncio.run(main())
