from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

from app.telegram import escape

TRIGGERS = ("fills", "move", "risk", "gateway", "events")
DEFAULT_TRIGGERS = frozenset(TRIGGERS)

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
    values = [terminal_pnl(positions, price) for price in sorted(prices)]
    return min(values) if values else None

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

def fill_message(event: dict[str, Any]) -> str:
    data = event.get("data") or {}
    side = str(data.get("side") or "").upper()
    action = "Bought" if side == "BOT" else "Sold" if side == "SLD" else side or "Filled"
    realized = decimal(data.get("realized_pnl"))
    lines = [
        f"<b>{escape(action)} {escape(compact(data.get('quantity')))} × {escape(contract_name(data))}</b>",
        f"at {escape(price_text(data.get('price')))} · {escape(event.get('account_id') or '')}",
    ]
    if realized is not None and realized != 0:
        lines.append(f"Booked <b>{escape(f'{realized:,.2f}')}</b>")
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
\
\
\
\
\

    return (before < level <= now) or (now <= level < before)

def price_message(symbol: str, price: Decimal, level: Decimal, rising: bool) -> str:
    arrow = "▲" if rising else "▼"
    return (
        f"<b>{escape(symbol)} {arrow} crossed {escape(f'{level:,.2f}')}</b>\n"
        f"now {escape(f'{price:,.2f}')}"
    )

def move_message(symbol: str, price: Decimal, anchor: Decimal, band: int, step: Decimal) -> str:
    percent = (price / anchor - Decimal(1)) * 100
    arrow = "▲" if percent >= 0 else "▼"
    return (
        f"<b>{escape(symbol)} {arrow} {percent:+.2f}%</b>\n"
        f"{escape(f'{price:,.2f}')} · crossed {band * int(step):+d}% from {escape(f'{anchor:,.2f}')}"
    )

def risk_message(account: str, now: Decimal, before: Decimal) -> str:
    change = now - before
    arrow = "▲" if change >= 0 else "▼"
    return (
        f"<b>Worst-case risk {arrow}</b>\n"
        f"{escape(account)}: {escape(f'{before:,.2f}')} → <b>{escape(f'{now:,.2f}')}</b> "
        f"({escape(f'{change:+,.2f}')})"
    )

def gateway_message(label: str, status: str, error: str | None) -> str:
    urgent = status in ("DISCONNECTED", "FAILED", "TWO_FACTOR_PENDING")
    head = "⚠️ " if urgent else ""
    lines = [f"{head}<b>Gateway {escape(status.replace('_', ' ').title())}</b>", escape(label)]
    if error:
        lines.append(escape(error)[:200])
    return "\n".join(lines)

GATEWAY_URGENT = ("FAILED", "TWO_FACTOR_PENDING")

GATEWAY_DEBOUNCED = ("DISCONNECTED", "DEGRADED")
GATEWAY_REPORTED = ("CONNECTED", *GATEWAY_URGENT, *GATEWAY_DEBOUNCED)

LOGIN_ATTENTION = ("two_factor", "two_factor_expired", "two_factor_device_required", "auth_failed")

def login_message(label: str, phase: str) -> str:
    wording = {
        "two_factor": "is waiting for two-factor approval",
        "two_factor_expired": "two-factor request expired",
        "two_factor_device_required": "has no two-factor device configured",
        "auth_failed": "login was rejected",
    }.get(phase, f"needs attention ({phase})")
    return f"⚠️ <b>Gateway login</b>\n{escape(label)} {escape(wording)}"

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
        f"<b>Gateway Recovered</b>\n{escape(label)}\n"
        f"back after {spell} {escape(status.replace('_', ' ').lower())}"
    )

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
    later = [e for e in ahead if e["date"] != today][:3]
    if later:
        lines.append("")
        lines.append("<b>Coming up</b>")
        for event in later:
            lines.append(f"• {escape(event['date'])} — {escape(describe(event))}")
    return "\n".join(lines)
