from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

from app.telegram import escape

TRIGGERS = ("fills", "move", "risk", "gateway", "events")
DEFAULT_TRIGGERS = frozenset(("move", "risk", "gateway", "events"))

COMMON_USER = "__common__"
COMMON_AVAILABLE = ("fills", "move", "risk", "events")
COMMON_DEFAULT = frozenset(("move", "risk", "events"))

def decimal(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None

@dataclass
class AlertState:
    bands: dict[str, int] = field(default_factory=dict)
    anchors: dict[str, Decimal] = field(default_factory=dict)
    risk: dict[str, Decimal] = field(default_factory=dict)
    risk_at: dict[str, Decimal] = field(default_factory=dict)
    spots: dict[str, Decimal] = field(default_factory=dict)
    books: dict[str, dict[int, dict[str, Any]]] = field(default_factory=dict)
    dirty: dict[str, float] = field(default_factory=dict)

    gateway: dict[str, str] = field(default_factory=dict)

    pending: dict[str, tuple[str, float]] = field(default_factory=dict)

    since: dict[str, float] = field(default_factory=dict)

    statuses: dict[str, str] = field(default_factory=dict)

    announced: str = ""

    labels: dict[str, str] = field(default_factory=dict)
    errors: dict[str, Any] = field(default_factory=dict)

def terminal_pnl(positions: list[dict[str, Any]], spot: Decimal) -> Decimal:
    total = Decimal(0)
    for position in positions:
        quantity = decimal(position.get("quantity")) or Decimal(0)
        if not quantity:
            continue
        cost = decimal(position.get("average_cost")) or Decimal(0)
        kind = position.get("sec_type")
        if kind == "STK":
            total += quantity * (spot - cost)
            continue
        if kind != "OPT":
            continue
        strike = decimal(position.get("strike"))
        multiplier = decimal(position.get("multiplier"))
        right = position.get("right")
        if strike is None or multiplier is None or right not in ("C", "P"):
            continue
        intrinsic = max(Decimal(0), spot - strike) if right == "C" else max(Decimal(0), strike - spot)
        total += quantity * (intrinsic * multiplier - cost)
    return total

def worst_terminal(positions: list[dict[str, Any]], spot: Decimal) -> Decimal | None:
    found = worst_terminal_at(positions, spot)
    return found[0] if found else None

def worst_terminal_at(
    positions: list[dict[str, Any]], spot: Decimal
) -> tuple[Decimal, Decimal] | None:
    if spot is None or spot <= 0:
        return None
    prices = {spot * Decimal("0.05"), spot, spot * Decimal("1.95")}
    for step in range(1, 40):
        prices.add(spot * (Decimal(1) + Decimal(step) / 20))
        low = spot * (Decimal(1) - Decimal(step) / 20)
        if low > 0:
            prices.add(low)
    for position in positions:
        strike = decimal(position.get("strike"))
        if strike and strike > 0 and decimal(position.get("quantity")):
            prices.update({strike, strike * Decimal("0.999"), strike * Decimal("1.001")})
    values = [(terminal_pnl(positions, price), price) for price in sorted(prices)]
    if not values:
        return None
    pnl, price = min(values, key=lambda pair: (pair[0], abs(pair[1] - spot)))
    return pnl, price

def band_of(price: Decimal, anchor: Decimal, step_percent: Decimal) -> int:
    if anchor <= 0 or step_percent <= 0:
        return 0
    return int((price / anchor - Decimal(1)) * 100 / step_percent)

_OCC = re.compile(r"^([A-Z0-9]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$")
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

def compact(value: Any) -> str:
    number = decimal(value)
    if number is None:
        return str(value or "")
    text = format(number, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"

def price_text(value: Any) -> str:
    number = decimal(value)
    if number is None:
        return str(value if value is not None else "")
    whole, frac = f"{number:,.4f}".split(".")
    frac = frac.rstrip("0")
    return f"{whole}.{frac.ljust(2, '0')}"

def contract_name(data: dict[str, Any]) -> str:
    raw = str(data.get("symbol") or data.get("underlying") or "").strip()
    kind = str(data.get("sec_type") or "").upper()
    if kind not in ("", "OPT", "FOP"):
        return raw
    match = _OCC.fullmatch(re.sub(r"\s+", "", raw))
    if not match:
        return raw
    root, yy, mm, dd, right, strike_raw = match.groups()
    month, day = int(mm), int(dd)
    if not 1 <= month <= 12 or not 1 <= day <= 31:
        return raw
    strike = decimal(strike_raw)
    if strike is None:
        return raw
    side = "Call" if right == "C" else "Put"
    return f"{root} {day} {_MONTHS[month - 1]} {yy} {compact(strike / Decimal(1000))} {side}"

def selected(prefs: dict[str, Any] | None, trigger: str, default: frozenset[str]) -> bool:
    chosen = None if not prefs else prefs.get("triggers")
    if chosen is None:
        chosen = default
    return trigger in chosen

def money(value: Any) -> str:
    number = decimal(value)
    return f"{number:,.2f}" if number is not None else str(value or "")

def signed(value: Any) -> str:
    number = decimal(value)
    return f"{number:+,.2f}" if number is not None else str(value or "")

def percent(value: Decimal, digits: int = 1) -> str:
    return f"{value:+.{digits}f}%"

def expiry_text(raw: Any) -> str:
    text = re.sub(r"\D", "", str(raw or ""))
    if len(text) < 8:
        return str(raw or "")
    year, month, day = int(text[:4]), int(text[4:6]), int(text[6:8])
    if not 1 <= month <= 12 or not 1 <= day <= 31:
        return str(raw or "")
    return f"{day} {_MONTHS[month - 1]} {year % 100:02d}"

def position_name(position: dict[str, Any]) -> str:
    kind = str(position.get("sec_type") or "").upper()
    symbol = str(position.get("symbol") or "").strip()
    if kind in ("OPT", "FOP") and position.get("strike") and position.get("right") in ("C", "P"):
        side = "Call" if position.get("right") == "C" else "Put"
        return f"{symbol} {expiry_text(position.get('expiry'))} {compact(position.get('strike'))} {side}".replace("  ", " ")
    named = contract_name({"symbol": position.get("local_symbol") or symbol, "sec_type": kind})
    return named or symbol

def book_of(positions: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    book: dict[int, dict[str, Any]] = {}
    for position in positions:
        quantity = decimal(position.get("quantity"))
        con_id = position.get("con_id")
        if con_id is None or not quantity:
            continue
        book[int(con_id)] = {**position, "quantity": quantity}
    return book

def position_changes(before: dict[int, dict[str, Any]], after: dict[int, dict[str, Any]]) -> list[str]:
    changes = []
    for con_id in sorted(set(before) | set(after), key=lambda c: position_name((after.get(c) or before.get(c) or {}))):
        was = decimal((before.get(con_id) or {}).get("quantity")) or Decimal(0)
        now = decimal((after.get(con_id) or {}).get("quantity")) or Decimal(0)
        if was == now:
            continue
        name = position_name(after.get(con_id) or before.get(con_id) or {})
        delta = now - was
        verb = "bought" if delta > 0 else "sold"
        if now == 0:
            changes.append(f"closed {compact(abs(was))} × {name}")
        elif was == 0:
            changes.append(f"{verb} {compact(abs(delta))} × {name}")
        else:
            changes.append(f"{verb} {compact(abs(delta))} × {name} (now {compact(now)})")
    return changes

def account_display(account_id: str, label: str = "") -> str:
    """Name and ID together, as the dashboard shows them, or just the ID when unnamed."""
    label = (label or "").strip()
    return f"{label} · {account_id}" if label else account_id

def fill_message(event: dict[str, Any], account_name: str = "") -> str:
    data = event.get("data") or {}
    side = str(data.get("side") or "").upper()
    action = "Bought" if side == "BOT" else "Sold" if side == "SLD" else side or "Filled"
    realized = decimal(data.get("realized_pnl"))
    quantity, price = decimal(data.get("quantity")), decimal(data.get("price"))
    multiplier = decimal(data.get("multiplier")) or Decimal(1)
    account = escape(account_name or event.get("account_id") or "")
    detail = f"{account} filled at {escape(price_text(data.get('price')))}"
    if quantity and price:
        detail += f" · {escape(money(abs(quantity) * price * multiplier))} {'paid' if action == 'Bought' else 'collected'}"
    lines = [
        f"<b>{escape(action)} {escape(compact(data.get('quantity')))} × {escape(contract_name(data))}</b>",
        detail,
    ]
    if realized is not None and realized != 0:
        lines.append(
            f"Booked <b>{escape(money(realized))}</b> realised P&amp;L on this fill"

        )
    return "\n".join(lines)

THRESHOLDS = {
    "move_percent": (2.0, 0.1, 50.0),
    "risk_percent": (10.0, 1.0, 500.0),
}

def threshold(prefs: dict[str, Any] | None, name: str) -> Decimal:

    fallback, low, high = THRESHOLDS[name]
    raw = (prefs or {}).get(name)
    value = decimal(raw)
    if value is None or not (Decimal(str(low)) <= value <= Decimal(str(high))):
        return Decimal(str(fallback))
    return value

def crossed(before: Decimal, now: Decimal, level: Decimal) -> bool:
    return (before < level <= now) or (now <= level < before)

def price_message(
    symbol: str, price: Decimal, level: Decimal, rising: bool, previous: Decimal | None = None
) -> str:
    arrow = "▲" if rising else "▼"
    direction = "up through" if rising else "down through"
    lines = [
        f"<b>{escape(symbol)} {arrow} {direction} {escape(money(level))}</b>",
        f"Now {escape(money(price))}"
        + (f", from {escape(money(previous))} a moment ago" if previous is not None else "")
        + ". This is a price level you asked to be told about.",
    ]
    return "\n".join(lines)

def move_message(
    symbol: str,
    price: Decimal,
    anchor: Decimal,
    band: int,
    step: Decimal,
    since: str = "",
    kind: str = "band",
) -> str:
    change = (price / anchor - Decimal(1)) * 100
    arrow = "▲" if change >= 0 else "▼"
    crossed_at = band * step
    origin = f"{escape(money(anchor))}, where it was when these alerts were armed"
    if since:
        origin += f" on {escape(since)}"
    lines = [f"<b>{escape(symbol)} {arrow} {percent(change, 2)} to {escape(money(price))}</b>"]
    if kind == "level":
        lines.append(f"Crossed the {escape(f'{abs(step):g}')}% move you asked about, from {origin}.")
    else:
        lines.append(f"Crossed {escape(f'{crossed_at:+g}')}% from {origin}.")
        further = (band + (1 if band > 0 else -1)) * step
        back = (band - (1 if band > 0 else -1)) * step
        retreat = f"back inside ±{step:g}%" if back == 0 else f"back through {back:+g}%"
        lines.append(
            f"Next alert at {escape(f'{further:+g}')}% ({escape(money(anchor * (1 + further / 100)))}) "
            f"or {escape(retreat)}."
        )
    return "\n".join(lines)

def risk_message(
    account: str,
    now: Decimal,
    before: Decimal,
    *,
    symbol: str = "",
    spot: Decimal | None = None,
    spot_before: Decimal | None = None,
    worst_at: Decimal | None = None,
    changes: list[str] | None = None,
) -> str:
    change = now - before
    arrow = "▲" if change >= 0 else "▼"
    worse = change < 0
    relative = f" ({abs(change / before * 100):.0f}%)" if before else ""
    head = f"<b>Worst-case risk {arrow} {escape(account)}</b>"
    if now < 0:
        exposure = f"Could lose up to <b>{escape(money(abs(now)))}</b> at expiry"
    else:
        exposure = f"Keeps at least <b>{escape(money(now))}</b> even at the worst expiry"
    if worst_at is not None and spot:
        drift = (worst_at / spot - Decimal(1)) * 100
        exposure += (
            f", if {escape(symbol or 'the underlying')} settles at {escape(money(worst_at))}"
            f" ({percent(drift)} from {escape(money(spot))})"
        )
    exposure += "."
    lines = [head, exposure]
    lines.append(
        f"Was {escape(money(before))} · {'worse' if worse else 'better'} by "
        f"{escape(money(abs(change)))}{escape(relative)}."
    )
    if changes:
        lines.append("Because you " + escape("; ".join(changes)) + ".")
    elif spot is not None and spot_before is not None and spot != spot_before:
        lines.append(
            f"No position changed; {escape(symbol or 'the underlying')} moved "
            f"{escape(money(spot_before))} → {escape(money(spot))}."
        )
    else:
        lines.append("Positions were repriced; no leg was added or removed.")
    lines.append("Worst case = the biggest loss if every open leg is held to expiry.")
    return "\n".join(lines)

GATEWAY_MEANING = {
    "DISCONNECTED": "Positions and prices are frozen until it reconnects. It retries on its own.",
    "RECONNECTING": "Positions and prices are frozen while it retries.",
    "CONNECTING": "Positions and prices are frozen while it connects.",
    "FAILED": "It has stopped retrying. Restart it from the dashboard; a fresh login will send a 2FA push to the enrolled phone.",
    "TWO_FACTOR_PENDING": "Approve the IBKR login on the enrolled phone. The request expires after about 3 minutes.",
    "DEGRADED": "Still connected, but IB reported a problem, so some prices or positions may be stale.",
    "CONNECTED": "Positions and prices are live again.",
}

def gateway_message(label: str, status: str, error: str | None) -> str:
    urgent = status in ("DISCONNECTED", "FAILED", "TWO_FACTOR_PENDING")
    head = "⚠️ " if urgent else ""
    lines = [f"{head}<b>Gateway {escape(status.replace('_', ' ').title())}</b> · {escape(label)}"]
    meaning = GATEWAY_MEANING.get(status)
    if meaning:
        lines.append(escape(meaning))
    if error:
        lines.append(f"IB said: {escape(error)[:200]}")
    return "\n".join(lines)

GATEWAY_URGENT = ("FAILED", "TWO_FACTOR_PENDING")

GATEWAY_DEBOUNCED = ("DISCONNECTED", "DEGRADED")
GATEWAY_REPORTED = ("CONNECTED", *GATEWAY_URGENT, *GATEWAY_DEBOUNCED)

LOGIN_ATTENTION = ("two_factor", "two_factor_expired", "two_factor_device_required", "auth_failed")

LOGIN_MEANING = {
    "two_factor": (
        "is waiting for two-factor approval",
        "Approve the IBKR notification on the enrolled phone within about 3 minutes, or the login lapses.",
    ),
    "two_factor_expired": (
        "two-factor request expired",
        "Nobody approved the push in time. Restart the gateway from the dashboard to send a new one.",
    ),
    "two_factor_device_required": (
        "has no two-factor device configured",
        "Enrol a phone for this IBKR username in Account Management before the gateway can log in.",
    ),
    "auth_failed": (
        "login was rejected",
        "IBKR refused the username or password. Check the credentials before restarting.",
    ),
}

def login_message(label: str, phase: str) -> str:
    wording, hint = LOGIN_MEANING.get(phase, (f"needs attention ({phase})", ""))
    lines = [f"⚠️ <b>Gateway login</b> · {escape(label)} {escape(wording)}"]
    if hint:
        lines.append(escape(hint))
    lines.append("Until it is in, positions and prices are not updating.")
    return "\n".join(lines)

def gateway_class(status: str, login_phase: str = "") -> str:
\
\
\
\
\
\
\

    if login_phase in LOGIN_ATTENTION:
        return "attention"
    if status == "CONNECTED":
        return "up"
    if status in ("DISCONNECTED", "FAILED", "RECONNECTING", "CONNECTING"):
        return "down"
    if status == "TWO_FACTOR_PENDING":
        return "attention"
    if status == "DEGRADED":
        return "degraded"
    return ""

def recovery_message(label: str, status: str, seconds: float) -> str:

    spell = f"{seconds / 60:.0f} min" if seconds >= 90 else f"{seconds:.0f}s"
    return (
        f"<b>Gateway Recovered</b> · {escape(label)}\n"
        f"It is back after {spell} {escape(status.replace('_', ' ').lower())}. "
        "Positions and prices are live again; anything that happened meanwhile is being caught up."
    )

EVENT_MEANING = {
    "holiday": "No US session, so nothing will move and no options expire today.",
    "half_day": "The session closes early, so today's expiries settle at the early close.",
    "fomc": "Rate decision at 2:00 pm ET; expect the sharpest move of the day around then.",
}

def events_message(today: str, events: list[dict[str, Any]], ahead: list[dict[str, Any]]) -> str:
\
\
\
\
\

    from app.events import describe

    lines = [f"<b>Event day — {escape(today)}</b>"]
    for event in events:
        lines.append(f"• {escape(describe(event))}")
        hint = EVENT_MEANING.get(str(event.get("kind") or ""))
        if hint:
            lines.append(f"  {escape(hint)}")
    later = [e for e in ahead if e["date"] != today][:3]
    if later:
        lines.append("")
        lines.append("<b>Coming up</b>")
        for event in later:
            lines.append(f"• {escape(event['date'])} — {escape(describe(event))}")
    return "\n".join(lines)
