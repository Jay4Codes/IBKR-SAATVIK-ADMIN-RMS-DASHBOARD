from __future__ import annotations

import asyncio
import os
import re
import stat
import tempfile

def _assign(text: str, key: str, value: str) -> str:
    pattern = re.compile(rf"^{re.escape(key)}=.*$", re.M)
    line = f"{key}={value}"
    return pattern.sub(lambda _: line, text, count=1) if pattern.search(text) else f"{text}\n{line}\n"

def apply_settings(text: str, values: dict[str, str]) -> str:
    for key, value in values.items():
        text = _assign(text, key, value)
    return text

def read_setting(key: str, path: str | None) -> str | None:
    if not path:
        return None
    try:
        with open(path) as handle:
            found = re.search(rf"^{re.escape(key)}=(.*)$", handle.read(), re.M)
    except OSError:
        return None
    value = found.group(1).strip() if found else ""
    return value or None

def read_username(path: str | None) -> str | None:
    return read_setting("IbLoginId", path)

def write_atomic(path: str, text: str, mode: int = stat.S_IRUSR | stat.S_IWUSR) -> None:
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    temporary = tempfile.NamedTemporaryFile("w", dir=directory, delete=False)
    try:
        temporary.write(text)
        temporary.flush()
        os.fsync(temporary.fileno())
        temporary.close()
        os.chmod(temporary.name, mode)
        os.replace(temporary.name, path)
    except BaseException:
        if os.path.exists(temporary.name):
            os.unlink(temporary.name)
        raise

def write_credentials(
    path: str,
    username: str,
    password: str,
    mode: str,
    port: int,
    *,
    read_only_login: bool | None = None,
    second_factor_device: str | None = None,
) -> None:
    with open(path) as handle:
        text = handle.read()
    values = {
        "IbLoginId": username,
        "IbPassword": password,
        "TradingMode": mode,
        "OverrideTwsApiPort": str(port),
    }
    if read_only_login is not None:
        values["ReadOnlyLogin"] = "yes" if read_only_login else "no"
    if second_factor_device is not None:
        values["SecondFactorDevice"] = second_factor_device
    write_atomic(path, apply_settings(text, values))

async def _systemctl(*args) -> tuple[int, str]:
    process = await asyncio.create_subprocess_exec(
        "systemctl", *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    output, _ = await process.communicate()
    return process.returncode, output.decode().strip()

async def process_state(unit: str) -> str:
    _, output = await _systemctl("is-active", unit)
    return output or "unknown"

async def process_action(action: str, unit: str) -> str:
    if action not in ("start", "stop", "restart"):
        raise ValueError("Unsupported gateway process action")
    code, output = await _systemctl(action, unit)
    if code != 0:
        raise RuntimeError(output or f"systemctl {action} {unit} failed")
    return await process_state(unit)

async def daemon_reload() -> None:
    code, output = await _systemctl("daemon-reload")
    if code != 0:
        raise RuntimeError(output or "systemctl daemon-reload failed")

async def unit_exists(unit: str) -> bool:
    code, output = await _systemctl("cat", unit)
    return code == 0 and bool(output)
