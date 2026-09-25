import asyncio
import contextlib
import copy
import json
import logging
import random
import re
import signal
import time
from decimal import Decimal
from uuid import uuid4
from zoneinfo import ZoneInfo

import httpx
from ib_async import IB, Index, StartupFetch
from redis.asyncio import Redis
from redis.exceptions import ResponseError

from app import alerts, events, massive, secrets, snaptrade, telegram
from app import connections as registry
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

SUPERVISE_INTERVAL = 10.0
SESSION_RESTART_BACKOFF = 60.0
LEASE_SECONDS = 20

BROKER_NOTICES = (2104, 2106, 2107, 2108, 2119, 2150, 2158)
BROKER_FARM_FAULTS = (2103, 2105, 2157)
BROKER_FARM_RECOVERED = (2104, 2106, 2119, 2158)
BROKER_FATAL = (1100, 1101, 1300, 326, 502, 504)
BROKER_RESTORED = 1102
BROKER_BAD_REQUEST = 321
BROKER_MARKET_DATA = (354, 10089, 10090, 10091, 10167, 10168, 10197)

def backoff(attempt):
    return min(60, 2 ** min(attempt, 6)) + random.uniform(0, 1)

async def durable_consumer(redis, db, tenant_id: str, stop: asyncio.Event):
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

async def telegram_linker(redis, db, stop: asyncio.Event):
    if not telegram.configured():
        return
    offset = 0
    async with httpx.AsyncClient() as client:
        while not stop.is_set():
            try:
                batch = await telegram.updates(client, offset)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("telegram.linker_failed")
                await asyncio.sleep(5)
                continue
            if not batch:
                await asyncio.sleep(settings.telegram_poll_seconds)
                continue
            for update in batch:
                offset = max(offset, int(update.get("update_id", 0)) + 1)
                group = telegram.group_chat(update)
                if group:

                    log.info(
                        "telegram.group_seen chat_id=%s title=%s "
                        "(set TELEGRAM_TEAM_CHAT_ID to use it)",
                        group[0], group[1],
                    )
                    await announce_group(redis, client, *group)
                started = telegram.started_with(update)
                if not started:
                    continue
                code, chat_id, name = started
                user_id = await redis.get(f"telegram:link:{code}")
                if not user_id:
                    await telegram.send(
                        client, chat_id,
                        "That link has expired. Open Alerts in the dashboard and try again.",
                    )
                    continue
                await db.telegram_links.delete_many({"chat_id": chat_id})
                await db.telegram_links.update_one(
                    {"_id": user_id},
                    {"$set": {"chat_id": chat_id, "name": name, "linked_at": now().isoformat()}},
                    upsert=True,
                )
                await redis.delete(f"telegram:link:{code}")
                log.info("telegram.linked user=%s chat=%s", user_id, chat_id)
                await telegram.send(
                    client, chat_id,
                    "<b>Alerts connected.</b>\n"
                    "You will hear about underlying moves (each band SPX crosses from where it "
                    "was when this was armed), worst-case risk changes (the biggest expiry loss "
                    "of an account moving by your threshold, with what caused it), gateway "
                    "problems and event days, for the accounts you can see. "
                    "Tune thresholds under Alerts in the dashboard.",
                )

async def refresh_events(db, stop: asyncio.Event):
\
\
\
\
\
\

    while not stop.is_set():
        try:
            async with httpx.AsyncClient() as client:
                found = await events.fetch_holidays(client) + await events.fetch_fomc(client)
            for event in found:
                await db.market_events.update_one(
                    {"date": event["date"], "kind": event["kind"], "name": event["name"]},
                    {"$set": event},
                    upsert=True,
                )
            if found:
                log.info("events.refreshed count=%s", len(found))
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("events.refresh_failed")
        try:
            await asyncio.wait_for(stop.wait(), settings.event_refresh_seconds)
        except TimeoutError:
            pass

async def announce_group(redis, client, chat_id: str, title: str):
\
\
\
\
\
\

    if settings.telegram_team_chat_id:
        return
    if not await redis.set(f"telegram:greeted:{chat_id}", "1", ex=86400, nx=True):
        return
    await telegram.send(
        client, chat_id,
        f"<b>Sattvic RMS Alerts</b>\nConnected to <b>{telegram.escape(title)}</b>.\n\n"
        f"This chat's id is <code>{telegram.escape(chat_id)}</code> — give it to whoever "
        "runs the platform to start sending desk alerts here.",
    )

class AlertDispatcher:
    def __init__(self, redis, db, tenant_id: str):
        self.redis, self.db, self.tenant_id = redis, db, tenant_id
        self.keys = TenantKeys(tenant_id)
        self.state = alerts.AlertState()

        self.names: dict[str, str] = {}
        self.group = f"{self.keys.consumer_group}:alerts"

    async def once(self, marker: str, ttl: int = 604800) -> bool:
\
\
\
\
\
\
\
\

        key = f"{self.keys.prefix}:alerted:{marker}"
        return bool(await self.redis.set(key, "1", ex=ttl, nx=True))

    async def recipients(self, account_id: str | None) -> list[str]:
        chats: list[str] = []
        members = self.db.tenant_members.find({"tenant_id": self.tenant_id, "status": "ACTIVE"})
        async for member in members:
            accounts = member.get("accounts") or []
            sees_all = member.get("sees_all_accounts") or not accounts
            if account_id and not sees_all and account_id not in accounts:
                continue
            link = await self.db.telegram_links.find_one({"_id": member.get("user_id")})
            if link and link.get("chat_id"):
                chats.append(str(link["chat_id"]))
        return chats

    async def wants(self, trigger: str) -> set[str]:
        allowed: set[str] = set()
        cursor = self.db.alert_preferences.find({"tenant_id": self.tenant_id})
        overrides = {doc.get("user_id"): doc.get("triggers") for doc in await cursor.to_list(5000)}
        members = self.db.tenant_members.find({"tenant_id": self.tenant_id, "status": "ACTIVE"})
        async for member in members:
            user_id = member.get("user_id")
            triggers = overrides.get(user_id)
            if triggers is None:
                triggers = list(alerts.DEFAULT_TRIGGERS)
            if trigger not in triggers:
                continue
            link = await self.db.telegram_links.find_one({"_id": user_id})
            if link and link.get("chat_id"):
                allowed.add(str(link["chat_id"]))
        return allowed

    async def deliver(
        self, client, trigger: str, account_id: str | None, text: str, urgent: bool = False
    ):
        entitled = set(await self.recipients(account_id))
        wanted = await self.wants(trigger)
        for chat_id in sorted(entitled & wanted):
            await telegram.send(client, chat_id, text)
        common = await self.common_prefs()
        if (
            common is not None
            and trigger != "gateway"
            and alerts.selected(common, trigger, alerts.COMMON_DEFAULT)
        ):
            await telegram.send(client, settings.telegram_team_chat_id, text)
        if trigger != "fills":
            await self.raise_alert(trigger, account_id, text, urgent)

    async def common_prefs(self) -> dict | None:
        if not settings.telegram_team_chat_id:
            return None
        if self.db is None:
            return {}
        found = await self.db.alert_preferences.find_one(
            {"tenant_id": self.tenant_id, "user_id": alerts.COMMON_USER}, {"_id": 0}
        )
        return found or {}

    async def raise_alert(self, trigger: str, account_id: str | None, text: str, urgent: bool):
\
\
\
\
\

        await StateRepository(self.redis, self.tenant_id, "alerts").publish(
            Event(
                event_type="alert.raised",
                account_id=account_id or "*",
                data={
                    "trigger": trigger,
                    "text": text,

                    "plain": re.sub(r"<[^>]+>", "", text),
                    "urgent": urgent,
                },
            )
        )

    async def positions_for(self, account_id: str) -> list[dict]:
        raw = await self.redis.hvals(self.keys.account_rows(account_id, "positions"))
        return [json.loads(row) for row in raw]

    async def account_name(self, account_id: str | None) -> str:
        """The account as the desk knows it: its label and ID, or the ID alone."""
        if not account_id:
            return ""
        key = f"account:{account_id}"
        if key not in self.names:
            label = ""
            if self.db is not None:
                doc = await self.db.ibkr_accounts.find_one(
                    {"tenant_id": self.tenant_id, "account_id": account_id}, {"label": 1}
                )
                label = (doc or {}).get("label") or ""
            self.names[key] = alerts.account_display(account_id, label)
        return self.names[key]

    async def label_for(self, connection_id: str) -> str:

        if not connection_id:
            return "Gateway"
        if connection_id not in self.names:
            doc = await self.db.broker_connections.find_one(
                {"_id": connection_id}, {"name": 1}
            )
            self.names[connection_id] = (doc or {}).get("name") or connection_id
        return self.names[connection_id]

    async def handle(self, client, event: dict, connection_id: str = ""):
        kind = event.get("event_type") or ""

        if kind.startswith("alert."):
            return
        data = event.get("data") or {}
        account = event.get("account_id")

        if kind == "execution.created":
            execution_id = str(data.get("execution_id") or event.get("event_id") or "")
            if execution_id and not await self.once(f"fill:{execution_id}"):
                return
            await self.deliver(
                client, "fills", account,
                alerts.fill_message(event, await self.account_name(account)),
            )
            return

        if kind.startswith("gateway."):
            status = str(data.get("status") or "")

            key = str(data.get("connection_id") or connection_id or self.tenant_id)
            label = await self.label_for(key)
            await self.gateway_changed(
                client, key, label, status, data.get("last_error"),
                str(data.get("login_phase") or ""),
            )
            return

        if kind in ("position.updated", "position.closed") and account:
            await self.underlying_moved(client, data)
            self.state.dirty.setdefault(account, time.time())
            if settings.alert_risk_settle_seconds <= 0:
                await self.settle_risk(client)

    async def gateway_changed(self, client, key: str, label: str, status: str, error, login_phase: str = ""):
\
\
\
\
\
\
\

        kind = alerts.gateway_class(status, login_phase)
        if not kind:
            return

        if key not in self.state.gateway:
            stored = await self.redis.get(f"{self.keys.prefix}:alerted:gateway:{key}")
            if stored:
                self.state.gateway[key] = stored
        reported = self.state.gateway.get(key)

        if kind == "up":
            self.state.pending.pop(key, None)
            if reported and reported != "up":
                since = self.state.since.pop(key, None)
                await self.remember_gateway(key, kind)
                await self.deliver(
                    client, "gateway", None,
                    alerts.recovery_message(
                        label, self.state.statuses.get(key, reported),
                        time.time() - (since or time.time()),
                    ),
                )
            else:

                await self.remember_gateway(key, kind)
            return

        if reported == kind:

            self.state.statuses[key] = status
            self.state.errors[key] = error
            return

        if status in alerts.GATEWAY_URGENT or kind == "attention":
            await self.remember_gateway(key, kind)
            self.state.statuses[key] = status
            self.state.since.setdefault(key, time.time())
            self.state.pending.pop(key, None)
            text = (
                alerts.login_message(label, login_phase)
                if login_phase in alerts.LOGIN_ATTENTION
                else alerts.gateway_message(label, status, error)
            )
            await self.deliver(client, "gateway", None, text, urgent=True)
            return

        if key not in self.state.pending:
            self.state.pending[key] = (status, time.time())
            self.state.labels[key] = label
            self.state.errors[key] = error

    async def announce_events(self, client):
\
\
\
\
\

        today = now().astimezone(ZoneInfo(settings.massive_session_timezone)).date().isoformat()
        if self.state.announced == today:
            return
        rows = await self.db.market_events.find(
            {"date": {"$gte": today}}, {"_id": 0}
        ).sort("date", 1).to_list(60)
        if not rows:

            return
        self.state.announced = today
        due = [row for row in rows if row["date"] == today]
        if not due:

            return

        if not await self.once(f"events:{today}", ttl=172800):
            return
        await self.deliver(
            client, "events", None, alerts.events_message(today, due, rows),
            urgent=any(row["kind"] == "holiday" for row in due),
        )

    async def remember_gateway(self, key: str, kind: str):

        self.state.gateway[key] = kind
        await self.redis.set(f"{self.keys.prefix}:alerted:gateway:{key}", kind, ex=604800)

    async def sweep_pending(self, client):

        grace = settings.alert_gateway_grace_seconds
        for key, (status, began) in list(self.state.pending.items()):
            if time.time() - began < grace:
                continue
            del self.state.pending[key]
            kind = alerts.gateway_class(status)
            if self.state.gateway.get(key) == kind:
                continue
            await self.remember_gateway(key, kind)
            self.state.statuses[key] = status
            self.state.since.setdefault(key, began)
            await self.deliver(
                client, "gateway", None,
                alerts.gateway_message(
                    self.state.labels.get(key, key), status, self.state.errors.get(key)
                ),
                urgent=True,
            )

    async def underlying_moved(self, client, data: dict):
\
\
\
\
\
\

        symbol = data.get("symbol")
        price = alerts.decimal(data.get("underlying_price"))
        if not symbol or price is None or price <= 0:
            return
        key = f"{data.get('currency')}:{symbol}"
        previous = self.state.anchors.get(f"last:{key}")
        self.state.anchors[f"last:{key}"] = price

        for member, prefs in await self.members("move"):
            chat = member["chat_id"]
            step = alerts.threshold(prefs, "move_percent")
            anchor = alerts.decimal(await self.redis.get(f"{self.keys.prefix}:anchor:{chat}:{key}"))
            if anchor is None or anchor <= 0:
                await self.redis.set(f"{self.keys.prefix}:anchor:{chat}:{key}", str(price))
                await self.redis.set(
                    f"{self.keys.prefix}:anchor_at:{chat}:{key}", now().strftime("%-d %b")
                )
                continue
            since = await self.redis.get(f"{self.keys.prefix}:anchor_at:{chat}:{key}")
            since = since.decode() if isinstance(since, bytes) else (since or "")
            wanted = [alerts.decimal(level) for level in prefs.get("move_levels") or []]
            wanted = [level for level in wanted if level and level > 0]
            if wanted:

                if previous is None:
                    continue
                for level in wanted:
                    for target in (anchor * (1 + level / 100), anchor * (1 - level / 100)):
                        if not alerts.crossed(previous, price, target):
                            continue
                        text = alerts.move_message(
                            symbol, price, anchor,
                            1 if target > anchor else -1, level, since=since, kind="level",
                        )
                        await telegram.send(client, chat, text)
                        await self.raise_alert("move", None, text, False)
                continue

            band = alerts.band_of(price, anchor, step)
            seen = int(await self.redis.get(f"{self.keys.prefix}:band:{chat}:{key}") or 0)
            if band != seen:
                await self.redis.set(f"{self.keys.prefix}:band:{chat}:{key}", str(band))
                if band != 0:
                    text = alerts.move_message(symbol, price, anchor, band, step, since=since)
                    await telegram.send(client, chat, text)
                    await self.raise_alert("move", None, text, False)

            if previous is None:
                continue
            for raw in prefs.get("price_levels") or []:
                level = alerts.decimal(raw)
                if level is None or not alerts.crossed(previous, price, level):
                    continue
                text = alerts.price_message(symbol, price, level, price >= previous, previous)
                await telegram.send(client, chat, text)
                await self.raise_alert("move", None, text, False)

        common = await self.common_prefs()
        if common is not None and previous is not None and alerts.selected(common, "move", alerts.COMMON_DEFAULT):
            await self.desk_move(client, key, symbol, previous, price, common)

    async def desk_move(self, client, key: str, symbol: str, previous, price, prefs: dict):

        anchor = self.state.anchors.get(key)
        if anchor is None:
            self.state.anchors[key] = price
            self.state.bands[key] = 0
            return
        wanted = [alerts.decimal(level) for level in prefs.get("move_levels") or []]
        wanted = [level for level in wanted if level and level > 0]
        if wanted:
            for level in wanted:
                for target in (anchor * (1 + level / 100), anchor * (1 - level / 100)):
                    if not alerts.crossed(previous, price, target):
                        continue
                    await telegram.send(
                        client, settings.telegram_team_chat_id,
                        alerts.move_message(
                            symbol, price, anchor, 1 if target > anchor else -1, level, kind="level"
                        ),
                    )
        else:
            step = alerts.threshold(prefs, "move_percent")
            band = alerts.band_of(price, anchor, step)
            if band != self.state.bands.get(key, 0):
                self.state.bands[key] = band
                if band != 0:
                    await telegram.send(
                        client, settings.telegram_team_chat_id,
                        alerts.move_message(symbol, price, anchor, band, step),
                    )
        for raw in prefs.get("price_levels") or []:
            level = alerts.decimal(raw)
            if level is None or not alerts.crossed(previous, price, level):
                continue
            await telegram.send(
                client, settings.telegram_team_chat_id,
                alerts.price_message(symbol, price, level, price >= previous, previous),
            )

    async def members(self, trigger: str):

        cursor = self.db.alert_preferences.find({"tenant_id": self.tenant_id})
        prefs = {doc.get("user_id"): doc for doc in await cursor.to_list(5000)}
        out = []
        rows = self.db.tenant_members.find({"tenant_id": self.tenant_id, "status": "ACTIVE"})
        async for member in rows:
            user_id = member.get("user_id")
            mine = prefs.get(user_id) or {}
            triggers = mine.get("triggers")
            if triggers is None:
                triggers = list(alerts.DEFAULT_TRIGGERS)
            if trigger not in triggers:
                continue
            link = await self.db.telegram_links.find_one({"_id": user_id})
            if link and link.get("chat_id"):
                out.append(({"user_id": user_id, "chat_id": str(link["chat_id"])}, mine))
        return out

    async def settle_risk(self, client):
        due = time.time() - settings.alert_risk_settle_seconds
        for account in [a for a, stamp in self.state.dirty.items() if stamp <= due]:
            del self.state.dirty[account]
            await self.risk_changed(client, account)

    async def risk_changed(self, client, account_id: str):
        positions = await self.positions_for(account_id)
        spot = self.spot_of(positions)
        found = alerts.worst_terminal_at(positions, spot)
        if found is None:
            return
        worst, worst_at = found
        book = alerts.book_of(positions)
        before = self.state.risk.get(account_id)
        spot_before = self.state.spots.get(account_id)
        held = self.state.books.get(account_id)
        self.state.risk[account_id] = worst
        self.state.risk_at[account_id] = worst_at
        self.state.spots[account_id] = spot
        self.state.books[account_id] = book
        if before is None:
            return
        moved = abs(worst - before)
        entitled = set(await self.recipients(account_id))
        symbol = next(
            (str(p.get("symbol") or "") for p in positions if alerts.decimal(p.get("underlying_price"))),
            "",
        )
        text = alerts.risk_message(
            await self.account_name(account_id), worst, before,
            symbol=symbol,
            spot=spot,
            spot_before=spot_before,
            worst_at=worst_at,
            changes=alerts.position_changes(held, book) if held is not None else None,
        )
        told = False
        for member, prefs in await self.members("risk"):
            if member["chat_id"] not in entitled:
                continue

            want = abs(before) * alerts.threshold(prefs, "risk_percent") / 100
            if moved < max(want, Decimal(1)):
                continue
            await telegram.send(client, member["chat_id"], text)
            told = True
        common = await self.common_prefs()
        if common is not None and alerts.selected(common, "risk", alerts.COMMON_DEFAULT):
            desk = abs(before) * alerts.threshold(common, "risk_percent") / 100
            if moved >= max(desk, Decimal(1)):
                await telegram.send(client, settings.telegram_team_chat_id, text)
                told = True
        if told:
            await self.raise_alert("risk", account_id, text, False)

    @staticmethod
    def spot_of(positions: list[dict]) -> Decimal:
        for position in positions:
            price = alerts.decimal(position.get("underlying_price"))
            if price and price > 0:
                return price
        return Decimal(0)

    async def run(self, stop: asyncio.Event):
        if not telegram.configured():
            return
        try:
            await self.redis.xgroup_create(self.keys.events, self.group, id="$", mkstream=True)
        except ResponseError as exc:
            if "BUSYGROUP" not in str(exc):
                raise
        async with httpx.AsyncClient() as client:
            while not stop.is_set():
                try:
                    batches = await self.redis.xreadgroup(
                        self.group, "alerts", {self.keys.events: ">"}, count=50, block=1000
                    )
                    await self.sweep_pending(client)
                    await self.settle_risk(client)
                    await self.announce_events(client)
                    for _, entries in batches or []:
                        for event_id, fields in entries:
                            try:
                                await self.handle(
                                    client,
                                    json.loads(fields["event"]),
                                    fields.get("connection_id", ""),
                                )
                            finally:
                                await self.redis.xack(self.keys.events, self.group, event_id)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    log.exception("alerts.dispatch_failed tenant=%s", self.tenant_id)
                    await asyncio.sleep(2)

class Session:

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
        if message.get("command") == "reconnect":
            log.info("command.reconnect_requested connection=%s", self.label)
            self.reconnect.set()
            self.on_reconnect()

    def on_reconnect(self):
        pass

class GatewaySession(Session):

    def __init__(self, redis, db, tenant_id: str, connection: dict, ib=None):
        super().__init__(redis, db, tenant_id, connection)
        self.ib = ib or IB()
        self.ib.RaiseRequestErrors = True
        self.fault = asyncio.Event()
        self.queue = asyncio.Queue(maxsize=20000)
        self.accounts = {}
        self.positions = {}
        self.pnl_subscriptions = set()
        # Day P&L of legs closed earlier today, per (account, symbol): IB stops reporting a leg
        # once it is flat, but what it made or lost today still belongs to that asset's day.
        self.closed_day_pnl: dict[tuple[str, str], Decimal] = {}
        self.closed_day: str = ""
        self.execution_versions = {}
        self.order_versions = {}
        self.account_filter = (connection.get("account_filter") or "").strip()
        self.farm_fault = None
        self.contracts = {}
        self.market_wanted = {}
        self.market_subscriptions = {}
        self.market_denied = set()
        self.market_data_denied = False
        self.underlying_prices = {}
        self.previous_closes = {}
        self.massive_prices = {}
        self.cached_prices = {}
        self.live_underlyings = set()
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

    PSEUDO_ACCOUNTS = frozenset({"All", "ALL"})

    def accept_account(self, account):
        if not account or account in self.PSEUDO_ACCOUNTS:
            return False
        return not self.account_filter or self.account_filter == account

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
        if item.quantity == 0 and previous is not None and previous.quantity != 0 and previous.day_pnl is not None:
            self.carry_closed_day_pnl(item.account_id, item.symbol, previous.day_pnl)
        item.underlying_price = self.underlying_of(item)
        item.underlying_source = self.underlying_source_of(item)
        item.underlying_prev_close = self.previous_close_of(item)
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
                "underlying_prev_close": self.previous_close_of(item),
                "market_value": norm.decimal(value.value),
                "unrealized_pnl": norm.decimal(value.unrealizedPnL),
                "realized_pnl": norm.decimal(value.realizedPnL),
                "day_pnl": norm.decimal(value.dailyPnL),
                "updated_at": now(),
            }
        )
        if item.market_value is not None and item.quantity:
            item.market_price = item.market_value / (item.quantity * (item.multiplier or Decimal(1)))
        self.positions[(value.account, value.conId)] = item
        self.enqueue("position.closed" if item.quantity == 0 else "position.updated", item)

    def carry_closed_day_pnl(self, account_id: str, symbol: str, amount: Decimal):
        today = now().date().isoformat()
        if self.closed_day != today:
            self.closed_day_pnl.clear()
            self.closed_day = today
        key = (account_id, symbol)
        self.closed_day_pnl[key] = self.closed_day_pnl.get(key, Decimal(0)) + amount

    def asset_day_pnl(self, report_date: str) -> dict[tuple[str, str], dict]:
        """Today's P&L per (account, asset): open legs as IB reports them, plus legs closed today."""
        totals: dict[tuple[str, str], dict] = {}
        for item in self.positions.values():
            if item.quantity == 0 or item.day_pnl is None:
                continue
            row = totals.setdefault(
                (item.account_id, item.symbol),
                {"day_pnl": Decimal(0), "legs": 0, "currency": item.currency},
            )
            row["day_pnl"] += item.day_pnl
            row["legs"] += 1
        if self.closed_day == report_date:
            for (account_id, symbol), amount in self.closed_day_pnl.items():
                row = totals.setdefault(
                    (account_id, symbol), {"day_pnl": Decimal(0), "legs": 0, "currency": ""}
                )
                row["day_pnl"] += amount
        return totals

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
        if item.sec_type != "OPT":
            return None
        key = self.underlying_key(item)
        if item.currency == "USD" and item.symbol.upper() in settings.massive_symbols:
            stored = self.cached_prices.get(key)
            return stored.price if stored is not None else None
        vendor = self.massive_prices.get(key)
        if vendor is not None:
            return vendor.price
        broker = self.underlying_prices.get(key)
        if broker is not None:
            return broker
        cached = self.cached_prices.get(key)
        return cached.price if cached is not None else None

    def previous_close_of(self, item):
        if item.sec_type != "OPT":
            return None
        found = self.previous_closes.get(self.underlying_key(item))
        return found[1] if found else None

    async def refresh_previous_closes(self):
        today = now().astimezone(ZoneInfo(settings.massive_session_timezone)).date().isoformat()
        for key, con_id in list(self.market_wanted.items()) + [
            (k, None) for k in self.market_subscriptions
        ]:
            stamped = self.previous_closes.get(key)
            if stamped and stamped[0] == today:
                continue
            if key in self.market_denied:
                continue
            contract = self.market_subscriptions.get(key) or self.contracts.get(con_id)
            if contract is None:
                continue
            if not getattr(contract, "exchange", ""):
                contract = copy.copy(contract)
                contract.exchange = "SMART"
            try:
                bars = await asyncio.wait_for(
                    self.ib.reqHistoricalDataAsync(
                        contract, endDateTime="", durationStr="5 D", barSizeSetting="1 day",
                        whatToShow="TRADES", useRTH=True, formatDate=1,
                    ),
                    settings.connection_timeout,
                )
            except Exception as exc:
                log.warning(
                    "underlying.previous_close_unavailable connection=%s key=%s error=%s",
                    self.label, key, exc,
                )
                self.previous_closes[key] = (today, self.previous_closes.get(key, (None, None))[1])
                continue
            prior = [b for b in bars if str(b.date) < today]
            if not prior:
                self.previous_closes[key] = (today, None)
                continue
            self.previous_closes[key] = (today, norm.decimal(prior[-1].close))
            log.info(
                "underlying.previous_close connection=%s key=%s close=%s",
                self.label, key, self.previous_closes[key][1],
            )

    def underlying_source_of(self, item) -> str:
        if item.sec_type != "OPT":
            return ""
        key = self.underlying_key(item)
        if item.currency == "USD" and item.symbol.upper() in settings.massive_symbols:
            stored = self.cached_prices.get(key)
            if stored is None:
                return ""
            return stored.source if key in self.live_underlyings else f"{stored.source}_cached"
        vendor = self.massive_prices.get(key)
        if vendor is not None:
            return vendor.source
        if key in self.underlying_prices:
            return "ib_und_price"
        cached = self.cached_prices.get(key)
        return f"{cached.source}_cached" if cached is not None else ""

    def track_underlying(self, item, contract):
        if item.sec_type != "OPT" or self.market_data_denied or not contract:
            return
        key = self.underlying_key(item)
        if key in self.market_denied:
            return
        self.contracts[item.con_id] = contract
        if item.quantity != 0:
            self.market_wanted.setdefault(key, item.con_id)
            return
        if self.market_wanted.get(key) == item.con_id:
            del self.market_wanted[key]
        if (subscribed := self.market_subscriptions.pop(key, None)) is not None:
            self.ib.cancelMktData(subscribed)
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
        symbols = settings.massive_symbols
        if not symbols:
            await self.stop.wait()
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
                        if archived and key in self.live_underlyings:
                            self.live_underlyings.discard(key)
                            self.massive_prices.pop(key, None)
                            self.underlying_changed.add(key)
                    except Exception:
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
                    key = f"USD:{symbol}"
                    try:
                        spot = await massive.fetch_spot(client, symbol)
                    except massive.RateLimited as exc:
                        log.warning("massive.rate_limited connection=%s path=%s", self.label, exc)
                        limited = True
                        break
                    if spot is None:
                        if self.massive_prices.pop(key, None) is not None:
                            broker = self.underlying_prices.get(key)
                            if broker is not None:
                                self.enqueue_underlying_sample(
                                    "USD", symbol, broker, "ib_und_price"
                                )
                            else:
                                self.live_underlyings.discard(key)
                                self.underlying_changed.add(key)
                        continue
                    answered = True
                    try:
                        await massive.record_sample(self.redis, symbol, spot, at=moment)
                    except Exception:
                        log.exception("massive.sample_store_failed symbol=%s", symbol)
                        continue
                    stored = await massive.last_spot(self.redis, symbol)
                    if stored is None:
                        continue
                    self.cached_prices[key] = stored
                    self.live_underlyings.add(key)
                    if getattr(self.massive_prices.get(key), "price", None) != spot.price:
                        self.massive_prices[key] = stored
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
                    continue
                snapshot = {
                    "tenant_id": self.tenant_id,
                    "account_id": account.account_id,
                    "report_date": report_date,
                    "taken_at": moment.isoformat(),
                    "currency": account.currency,
                    "net_liquidation": str(account.net_liquidation),
                    "cash": None if account.cash is None else str(account.cash),
                    "day_pnl": None if account.day_pnl is None else str(account.day_pnl),
                    "realized_pnl": None
                    if account.realized_pnl is None
                    else str(account.realized_pnl),
                    "unrealized_pnl": None
                    if account.unrealized_pnl is None
                    else str(account.unrealized_pnl),
                    "source": "snapshot",
                }
                try:
                    await self.db.account_snapshots.update_one(
                        {"_id": snapshot_id(self.tenant_id, account.account_id, report_date, bucket)},
                        {"$set": snapshot},
                        upsert=True,
                    )
                    self.queue.put_nowait(
                        Event(
                            event_type="snapshot.recorded",
                            account_id=account.account_id,
                            data=snapshot,
                        )
                    )
                except Exception:
                    log.exception("snapshot.write_failed connection=%s account=%s",
                                  self.label, account.account_id)
            await self.snapshot_assets(moment, report_date, bucket)

    async def snapshot_assets(self, moment, report_date: str, bucket: str):
        for (account_id, symbol), row in self.asset_day_pnl(report_date).items():
            currency = row["currency"] or getattr(self.accounts.get(account_id), "currency", "") or ""
            try:
                await self.db.asset_pnl_snapshots.update_one(
                    {"_id": f"{snapshot_id(self.tenant_id, account_id, report_date, bucket)}:{symbol}"},
                    {
                        "$set": {
                            "tenant_id": self.tenant_id,
                            "account_id": account_id,
                            "symbol": symbol,
                            "report_date": report_date,
                            "taken_at": moment.isoformat(),
                            "currency": currency,
                            "day_pnl": str(row["day_pnl"]),
                            "legs": row["legs"],
                        }
                    },
                    upsert=True,
                )
            except Exception:
                log.exception("snapshot.asset_write_failed connection=%s account=%s symbol=%s",
                              self.label, account_id, symbol)

    async def subscribe_underlyings(self):
        for key, con_id in list(self.market_wanted.items()):
            if self.market_data_denied:
                return
            if key in self.market_subscriptions or key in self.market_denied or con_id not in self.contracts:
                continue
            if key == "USD:SPX":
                wanted = Index("SPX", "CBOE", "USD")
            else:
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
        self.market_data_denied = True
        for key, contract in self.market_subscriptions.items():
            self.ib.cancelMktData(contract)
            self.mark_underlying_stale(key)
        self.market_subscriptions.clear()
        self.market_wanted.clear()

    def deny_market_data_line(self, req_id, contract) -> bool:
        if contract is None:
            known = getattr(self.ib.wrapper, "reqId2Ticker", {})
            contract = getattr(known[req_id], "contract", None) if req_id in known else None
        if contract is None or not getattr(contract, "symbol", None):
            return False
        key = f"{contract.currency}:{contract.symbol}"
        self.market_denied.add(key)
        self.market_wanted.pop(key, None)
        if (subscribed := self.market_subscriptions.pop(key, None)) is not None:
            self.ib.cancelMktData(subscribed)
        self.mark_underlying_stale(key)
        return True

    def mark_underlying_stale(self, key):
        if key in self.live_underlyings:
            self.live_underlyings.discard(key)
            self.underlying_changed.add(key)

    def ticker_value(self, tickers):
        for ticker in tickers:
            greeks, contract = ticker.modelGreeks, ticker.contract
            direct = getattr(contract, "secType", "") == "IND"
            price = norm.decimal(ticker.marketPrice()) if direct else (
                norm.decimal(getattr(greeks, "undPrice", None)) if greeks else None
            )
            if price is None or price <= 0 or contract is None:
                continue
            key = f"{contract.currency}:{contract.symbol}"
            if self.underlying_prices.get(key) != price:
                self.underlying_prices[key] = price
                if contract.currency == "USD" and contract.symbol.upper() in settings.massive_symbols:
                    if key not in self.massive_prices:
                        self.enqueue_underlying_sample(
                            contract.currency,
                            contract.symbol,
                            price,
                            "ib_index_ltp" if direct else "ib_und_price",
                        )
                else:
                    self.underlying_changed.add(key)

    def enqueue_underlying_sample(self, currency, symbol, price, source):
        self.queue.put_nowait(
            Event(
                event_type="underlying.sampled",
                account_id="*",
                data={
                    "currency": currency,
                    "symbol": symbol,
                    "price": str(price),
                    "source": source,
                },
            )
        )

    def flush_underlyings(self):
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
            if self.deny_market_data_line(req_id, contract):
                log.warning(
                    "broker.market_data_line_denied connection=%s code=%s request=%s message=%s",
                    self.label, code, req_id, message,
                )
            else:
                log.warning(
                    "broker.market_data_unavailable connection=%s code=%s message=%s",
                    self.label, code, message,
                )
                self.stop_market_data()
            return
        if code in BROKER_NOTICES:
            log.info("broker.notice connection=%s code=%s message=%s", self.label, code, message)
            if code in BROKER_FARM_RECOVERED:
                self.farm_recovered()
            return
        if code == BROKER_RESTORED:
            log.info("broker.restored connection=%s code=%s message=%s", self.label, code, message)
            self.farm_recovered()
            return
        if code == BROKER_BAD_REQUEST and req_id not in (None, -1):
            log.warning(
                "broker.request_rejected connection=%s code=%s request=%s message=%s",
                self.label, code, req_id, message,
            )
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
                if event.event_type == "underlying.sampled":
                    data = event.data
                    symbol = str(data["symbol"])
                    await massive.record_sample(
                        self.redis,
                        symbol,
                        massive.Spot(Decimal(str(data["price"])), str(data["source"])),
                        at=event.timestamp,
                    )
                    stored = await massive.last_spot(self.redis, symbol)
                    if stored is not None:
                        key = f"{data['currency']}:{symbol}"
                        self.cached_prices[key] = stored
                        self.live_underlyings.add(key)
                        self.underlying_changed.add(key)
                        self.flush_underlyings()
                else:
                    if event.event_type == "position.updated":
                        item = self.positions.get(
                            (event.account_id, int(event.data.get("con_id", 0)))
                        )
                        if item is not None:
                            price = self.underlying_of(item)
                            if price is not None:
                                event.data["underlying_price"] = str(price)
                                event.data["underlying_source"] = self.underlying_source_of(item)
                    await self.repo.publish(event)
            finally:
                self.queue.task_done()

    async def load_cached_underlyings(self):
        for symbol in settings.massive_symbols:
            spot = await massive.last_spot(self.redis, symbol)
            if spot is not None:
                self.cached_prices[f"USD:{symbol}"] = spot

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
                self.market_denied.clear()
                self.market_data_denied = False
                self.underlying_prices.clear()
                self.live_underlyings.clear()
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
                    await self.refresh_previous_closes()
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
            await self.load_cached_underlyings()
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

    def __init__(self, redis, db):
        self.redis, self.db = redis, db
        self.stop = asyncio.Event()
        self.sessions: dict[str, tuple[Session, asyncio.Task]] = {}
        self.consumers: dict[str, tuple[asyncio.Event, asyncio.Task]] = {}
        self.dispatchers: dict[str, tuple[asyncio.Event, asyncio.Task]] = {}
        self.restart_after: dict[str, float] = {}

    def fingerprint(self, doc: dict) -> str:
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
                if task.done() and not task.cancelled() and task.exception() is not None:
                    # A session that dies on its own is retried after a backoff, and the
                    # reason is logged, so a broken gateway does not flood the log with a
                    # silent stop/start pair every SUPERVISE_INTERVAL.
                    log.warning(
                        "supervisor.session_crashed connection=%s retry_in=%ss",
                        session.label, int(SESSION_RESTART_BACKOFF),
                        exc_info=task.exception(),
                    )
                    self.restart_after[connection_id] = time.monotonic() + SESSION_RESTART_BACKOFF
                elif task.done():
                    log.warning(
                        "supervisor.session_exited connection=%s retry_in=%ss",
                        session.label, int(SESSION_RESTART_BACKOFF),
                    )
                    self.restart_after[connection_id] = time.monotonic() + SESSION_RESTART_BACKOFF
                else:
                    log.info("supervisor.stopping connection=%s", session.label)
                session.stop.set()
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                del self.sessions[connection_id]

        for connection_id, doc in wanted.items():
            if connection_id in self.sessions:
                continue
            if time.monotonic() < self.restart_after.get(connection_id, 0.0):
                continue
            self.restart_after.pop(connection_id, None)
            session = build_session(self.redis, self.db, doc)
            if session is None:
                continue
            session.fingerprint = self.fingerprint(doc)
            log.info("supervisor.starting connection=%s", session.label)
            self.sessions[connection_id] = (session, asyncio.create_task(session.run()))

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

        for tenant_id in tenants - set(self.dispatchers):
            stop = asyncio.Event()
            dispatcher = AlertDispatcher(self.redis, self.db, tenant_id)
            self.dispatchers[tenant_id] = (stop, asyncio.create_task(dispatcher.run(stop)))
        for tenant_id in set(self.dispatchers) - tenants:
            stop, task = self.dispatchers.pop(tenant_id)
            stop.set()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def commands(self):
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
            asyncio.create_task(telegram_linker(self.redis, self.db, self.stop)),
            asyncio.create_task(refresh_events(self.db, self.stop)),
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
            for _, (stop, task) in self.dispatchers.items():
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
