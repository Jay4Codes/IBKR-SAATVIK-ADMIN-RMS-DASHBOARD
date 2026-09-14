import asyncio
import re
import socket
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app import connections, hostctl
from app.config import settings

LOGGED_IN = "logged_in"
STARTING = "starting"
CONNECTING = "connecting"
CONNECTING_STALE = "connecting_stale"
TWO_FACTOR = "two_factor"
TWO_FACTOR_EXPIRED = "two_factor_expired"
TWO_FACTOR_DEVICE_REQUIRED = "two_factor_device_required"
AUTH_FAILED = "auth_failed"
DOWN = "down"

_TIMESTAMP = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})[.:]\d{3}")
_SECOND_FACTOR_MARKERS = (
    "Second Factor Authentication initiated",
    "onStartTokenAuth",
    "detected dialog entitled: Second Factor Authentication",
    "detected dialog entitled: Security Code Card Authentication",
)
_EVENT_DEDUPE_SECONDS = 3
_DEVICE_REQUIRED_MARKER = "You should specify the required second factor device"
_SESSION_MARKERS = ("Starting IBC version", "Starting Gateway", "IBC: Starting session:")
_COMPLETION_MARKER = "Login has completed"
_CONNECTING_MARKER = "Connecting to server"
_FAILURE_MARKERS = ("Authorization failed", "Invalid username", "Login failed")
_EXIT_MARKERS = ("IBC terminated",)
_EXIT_PAIR = ("GATEWAY", "has finished")
_RECENT_LINES = 60
_QUARTER_HOUR = 900
_TAIL_BYTES = 256 * 1024


class LoginProgress:
    __slots__ = (
        "phase",
        "message",
        "two_factor_started_at",
        "two_factor_timeout_seconds",
        "two_factor_remaining_seconds",
        "two_factor_attempts",
    )

    def __init__(
        self,
        phase: str,
        message: str | None = None,
        two_factor_started_at: datetime | None = None,
        two_factor_timeout_seconds: int | None = None,
        two_factor_remaining_seconds: int | None = None,
        two_factor_attempts: int = 0,
    ):
        self.phase = phase
        self.message = message
        self.two_factor_started_at = two_factor_started_at
        self.two_factor_timeout_seconds = two_factor_timeout_seconds
        self.two_factor_remaining_seconds = two_factor_remaining_seconds
        self.two_factor_attempts = two_factor_attempts

    @property
    def awaiting_two_factor(self) -> bool:
        return self.phase == TWO_FACTOR and (self.two_factor_remaining_seconds or 0) > 0

    def as_dict(self) -> dict:
        started = self.two_factor_started_at
        return {
            "login_phase": self.phase,
            "login_message": self.message,
            "two_factor_started_at": started.isoformat(timespec="seconds") if started else None,
            "two_factor_timeout_seconds": self.two_factor_timeout_seconds,
            "two_factor_remaining_seconds": self.two_factor_remaining_seconds,
            "two_factor_attempts": self.two_factor_attempts,
        }


def read_two_factor_timeout(path: str | None) -> int:
    raw = hostctl.read_setting("SecondFactorAuthenticationTimeout", path)
    return int(raw) if raw and raw.isdigit() and int(raw) > 0 else settings.two_factor_timeout_seconds


def read_trading_mode(path: str | None) -> str:
    return (hostctl.read_setting("TradingMode", path) or "").lower() or "paper"


def read_only_login(path: str | None) -> bool:
    return (hostctl.read_setting("ReadOnlyLogin", path) or "").lower() in ("yes", "true")


def parse_timestamp(line: str) -> datetime | None:
    found = _TIMESTAMP.match(line)
    if not found:
        return None
    try:
        return datetime.strptime(found.group(1), "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def log_timezone_offset(path: Path | None, lines: list[str]) -> timedelta:
    if path is None:
        return timedelta(0)
    try:
        mtime = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
    except OSError:
        return timedelta(0)
    newest = next((s for s in (parse_timestamp(line) for line in reversed(lines)) if s), None)
    if newest is None:
        return timedelta(0)
    drift = (newest.replace(tzinfo=timezone.utc) - mtime).total_seconds()
    if abs(drift) > 14 * 3600 + _QUARTER_HOUR:
        return timedelta(0)
    return timedelta(seconds=round(drift / _QUARTER_HOUR) * _QUARTER_HOUR)


def _instant(stamp: datetime | None, offset: timedelta) -> datetime | None:
    return None if stamp is None else stamp.replace(tzinfo=timezone.utc) - offset


def _tail(path: Path, limit: int = _TAIL_BYTES) -> list[str]:
    try:
        with open(path, "rb") as handle:
            handle.seek(0, 2)
            start = max(0, handle.tell() - limit)
            handle.seek(start)
            text = handle.read().decode("utf-8", errors="replace")
    except OSError:
        return []
    lines = text.splitlines()
    return lines[1:] if start and len(lines) > 1 else lines


def newest_log(directory: str | None) -> Path | None:
    if not directory:
        return None
    folder = Path(directory)
    try:
        candidates = [p for p in folder.glob("ibc-*_GATEWAY-*.txt") if p.is_file()]
    except OSError:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime, default=None)


def collect_lines(directory: str | None, launcher_log: str | None = None) -> list[str]:
    lines: list[str] = []
    log = newest_log(directory)
    if log is not None:
        lines.extend(_tail(log)[-300:])
    if launcher_log:
        lines.extend(_tail(Path(launcher_log))[-120:])
    return lines


def _last_index(lines: list[str], markers: tuple[str, ...]) -> int:
    return max(
        (i for i, line in enumerate(lines) if any(m in line for m in markers)),
        default=-1,
    )


def _second_factor_events(lines: list[str], after: int, offset: timedelta) -> list[datetime]:
    stamps = sorted(
        s
        for s in (
            _instant(parse_timestamp(line), offset)
            for i, line in enumerate(lines)
            if i > after and any(m in line for m in _SECOND_FACTOR_MARKERS)
        )
        if s is not None
    )
    events: list[datetime] = []
    for stamp in stamps:
        if events and (stamp - events[-1]).total_seconds() < _EVENT_DEDUPE_SECONDS:
            continue
        events.append(stamp)
    return events


def evaluate(
    lines: list[str],
    *,
    process_active: bool,
    port_open: bool,
    timeout_seconds: int,
    stale_seconds: int | None = None,
    offset: timedelta = timedelta(0),
    moment: datetime | None = None,
) -> LoginProgress:
    moment = moment or datetime.now(timezone.utc)
    stale_seconds = settings.gateway_connect_stale_seconds if stale_seconds is None else stale_seconds

    if port_open:
        return LoginProgress(LOGGED_IN)
    if not process_active:
        return LoginProgress(DOWN, "Gateway process is not running")
    if not lines:
        return LoginProgress(STARTING, "Gateway starting — the API port is not open yet")

    recent = "\n".join(lines[-_RECENT_LINES:])
    if any(marker in recent for marker in _FAILURE_MARKERS):
        return LoginProgress(AUTH_FAILED, "IBKR rejected the login — check the configured credentials")

    cutoff = max(_last_index(lines, (_COMPLETION_MARKER,)), _last_index(lines, _SESSION_MARKERS))

    if _last_index(lines, (_DEVICE_REQUIRED_MARKER,)) > cutoff:
        return LoginProgress(
            TWO_FACTOR_DEVICE_REQUIRED,
            "Login is stuck on the second-factor device list: the account has more than "
            "one device enrolled and SecondFactorDevice is unset in config.ini, so no "
            "request was sent. Set it to the exact device name, then restart the Gateway.",
        )

    events = _second_factor_events(lines, cutoff, offset)
    if events:
        latest = events[-1]
        remaining = max(0, int(timeout_seconds - (moment - latest).total_seconds()))
        if remaining <= 0:
            return LoginProgress(
                TWO_FACTOR_EXPIRED,
                "Two-factor request timed out — restart the Gateway, then approve the push promptly",
                latest,
                timeout_seconds,
                0,
                len(events),
            )
        looping = f" Attempt {len(events)}." if len(events) > 1 else ""
        return LoginProgress(
            TWO_FACTOR,
            f"Approve the sign-in request in IBKR Mobile — {remaining}s remaining.{looping}",
            latest,
            timeout_seconds,
            remaining,
            len(events),
        )

    if _CONNECTING_MARKER in recent or _COMPLETION_MARKER in recent:
        started = next(
            (
                _instant(parse_timestamp(line), offset)
                for i, line in reversed(list(enumerate(lines)))
                if i > cutoff and _CONNECTING_MARKER in line
            ),
            None,
        )
        if started is None:
            return LoginProgress(CONNECTING, "Connecting to IBKR — waiting for authentication")
        elapsed = int((moment - started).total_seconds())
        if elapsed > stale_seconds:
            return LoginProgress(
                CONNECTING_STALE,
                f"Stuck connecting to IBKR for {elapsed}s — restart the Gateway to retry the login",
            )
        return LoginProgress(CONNECTING, f"Connecting to IBKR ({elapsed}s) — waiting for authentication")

    if any(marker in recent for marker in _EXIT_MARKERS) or all(
        marker in recent for marker in _EXIT_PAIR
    ):
        return LoginProgress(DOWN, "Gateway exited")
    return LoginProgress(STARTING, "Gateway starting — the API port is not open yet")


def port_is_open(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


async def snapshot(connection: dict) -> dict:
    unit = connections.unit_for(connection)
    config_path = connection.get("ibc_config_path")
    log_directory = connection.get("ibc_log_directory")
    launcher_log = connection.get("launcher_log") or None

    process = await hostctl.process_state(unit)
    port_open, lines, timeout, log = await asyncio.gather(
        asyncio.to_thread(
            port_is_open,
            connection.get("host") or "127.0.0.1",
            int(connection.get("api_port") or 0),
        ),
        asyncio.to_thread(collect_lines, log_directory, launcher_log),
        asyncio.to_thread(read_two_factor_timeout, config_path),
        asyncio.to_thread(newest_log, log_directory),
    )
    progress = evaluate(
        lines,
        process_active=process == "active",
        port_open=port_open,
        timeout_seconds=timeout,
        offset=log_timezone_offset(log, lines),
    )
    return {
        "process": process,
        "api_port_open": port_open,
        "gateway_username": hostctl.read_username(config_path),
        "trading_mode": read_trading_mode(config_path),
        "read_only_login": read_only_login(config_path),
        **progress.as_dict(),
    }


def restart_blocked(login: dict, grace_seconds: int | None = None) -> bool:
    grace = settings.two_factor_grace_seconds if grace_seconds is None else grace_seconds
    remaining = login.get("two_factor_remaining_seconds")
    return login.get("login_phase") == TWO_FACTOR and remaining is not None and remaining > grace
