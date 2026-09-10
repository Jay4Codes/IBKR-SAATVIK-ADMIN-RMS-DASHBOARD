"""Automated IB Gateway provisioning, one instance per broker connection.

Adding a tenant's IBKR link is otherwise a manual host task: copy IBC, edit a
config, pick a free port, write a systemd unit, remember which is which. This
module does all of it from the connection document, so onboarding a client is an
API call rather than an SSH session.

Each managed connection gets its own directory under `GATEWAY_INSTANCE_ROOT`:

    <root>/<connection id>/config.ini        IBC settings, 0600 (holds the login)
    <root>/<connection id>/gatewaystart.sh   IBC launcher, header rewritten
    <root>/<connection id>/settings/         TWS settings, private to the instance
    /var/log/ibc/<connection id>/            IBC logs the login poller reads

and runs under the templated unit `ibkr-gateway@<connection id>.service`.

The launcher is copied and rewritten rather than driven by environment
variables, because IBC's stock `gatewaystart.sh` **assigns** `IBC_INI` near the
top of the file and so silently ignores an `IBC_INI` inherited from the unit —
which would point every instance at the same config, and the same credentials.
"""

from __future__ import annotations

import os
import shutil
import stat
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from app import hostctl
from app.config import settings

#: Launcher variables rewritten per instance. Anything not listed keeps the
#: template's value, so a host-specific TWS_PATH or JAVA_PATH survives.
LAUNCHER_VARIABLES = ("IBC_INI", "LOG_PATH", "TWS_SETTINGS_PATH", "TRADING_MODE")

UNIT_TEMPLATE = """\
[Unit]
Description=IB Gateway instance %i (headless, managed by IBC)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=HOME=/root
WorkingDirectory={root}/%i
ExecStartPre=/bin/mkdir -p {logs}/%i
# xvfb-run owns the X server's lifetime and exports DISPLAY itself. Do not guard
# this with pgrep: a `pgrep -f "Xvfb :N"` matches its own command line and so
# always reports the server as already running.
ExecStart=/usr/bin/xvfb-run -a -s "-screen 0 1280x1024x24" {root}/%i/gatewaystart.sh -inline
Restart=on-failure
RestartSec=30
TimeoutStopSec=60
KillMode=mixed
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
"""

#: IBC settings every provisioned instance gets, whatever the template said.
BASE_SETTINGS = {
    # This platform is read-only throughout, and a read-only login skips the
    # second factor entirely — which is what makes an unattended start possible.
    # Set read_only_login=False on the connection to restore 2FA.
    "ReadOnlyLogin": "yes",
    "AcceptIncomingConnectionAction": "accept",
    "TrustedTwsApiClientIPs": "127.0.0.1",
    # Reclaim the session rather than queueing behind a stale one.
    "ExistingSessionDetectedAction": "primary",
    # Keep retrying after a second-factor timeout instead of exiting, so a
    # missed push does not leave the instance dead until someone notices.
    "ReloginAfterSecondFactorAuthenticationTimeout": "yes",
    "ExitAfterSecondFactorAuthenticationTimeout": "no",
    "AcceptNonBrokerageAccountWarning": "yes",
    "IbAutoClosedown": "no",
}


def instance_root(connection_id: str) -> Path:
    return Path(settings.gateway_instance_root) / connection_id


def paths(connection_id: str) -> dict[str, str]:
    """Where a managed instance's files live. Pure — creates nothing."""
    root = instance_root(connection_id)
    return {
        "ibc_config_path": str(root / "config.ini"),
        "ibc_log_directory": str(Path(settings.gateway_log_root) / connection_id),
        "launcher_path": str(root / "gatewaystart.sh"),
        "settings_path": str(root / "settings"),
        "service_unit": settings.gateway_instance_unit.format(instance=connection_id),
    }


def rewrite_launcher(text: str, values: dict[str, str]) -> str:
    """Point a copy of IBC's launcher at one instance's own files."""
    return hostctl.apply_settings(text, {k: v for k, v in values.items() if k in LAUNCHER_VARIABLES})


def _template_launcher() -> str:
    """The stock launcher to copy, taken from beside the template config."""
    candidate = Path(settings.gateway_template_config).parent / "gatewaystart.sh"
    try:
        return candidate.read_text()
    except OSError as exc:
        raise HTTPException(
            503,
            f"IBC launcher not readable at {candidate}. Install IBC, or point "
            f"GATEWAY_TEMPLATE_CONFIG at an IBC directory that contains gatewaystart.sh.",
        ) from exc


def _template_config() -> str:
    try:
        return Path(settings.gateway_template_config).read_text()
    except OSError as exc:
        raise HTTPException(
            503,
            f"IBC template config not readable at {settings.gateway_template_config}. "
            f"Set GATEWAY_TEMPLATE_CONFIG to an existing IBC config.ini.",
        ) from exc


def build_config(
    template: str,
    *,
    port: int,
    trading_mode: str,
    username: str | None = None,
    password: str | None = None,
    read_only_login: bool = True,
    second_factor_device: str | None = None,
    two_factor_timeout: int | None = None,
) -> str:
    """Render one instance's IBC config from the template.

    A connection may be provisioned before its credentials are known; the login
    fields are then left blank rather than inherited from the template, so a new
    tenant's gateway can never start up under another tenant's IBKR login.
    """
    values = dict(BASE_SETTINGS)
    values["OverrideTwsApiPort"] = str(port)
    values["TradingMode"] = trading_mode
    values["IbLoginId"] = username or ""
    values["IbPassword"] = password or ""
    values["ReadOnlyLogin"] = "yes" if read_only_login else "no"
    values["SecondFactorDevice"] = second_factor_device or ""
    values["SecondFactorAuthenticationTimeout"] = str(
        two_factor_timeout or settings.two_factor_timeout_seconds
    )
    return hostctl.apply_settings(template, values)


def _require_enabled() -> None:
    if not settings.gateway_provisioning_enabled:
        raise HTTPException(
            503,
            "Gateway provisioning is disabled on this host. Set "
            "GATEWAY_PROVISIONING_ENABLED=true, or register the connection as "
            "unmanaged with an existing config path and systemd unit.",
        )


def provision_files(doc: dict[str, Any], *, password: str | None = None) -> dict[str, str]:
    """Create or refresh one connection's IBC directory. Blocking; run in a thread.

    Idempotent: re-provisioning an existing instance rewrites its config and
    launcher and leaves its settings directory and logs alone.
    """
    _require_enabled()
    connection_id = doc["_id"]
    layout = paths(connection_id)
    root = instance_root(connection_id)

    template = _template_config()
    launcher = _template_launcher()

    # Preserve a password already written to this instance's config: rewriting
    # the file for a port or mode change must not silently blank the login.
    existing_password = password
    if existing_password is None and os.path.exists(layout["ibc_config_path"]):
        existing_password = hostctl.read_setting("IbPassword", layout["ibc_config_path"])

    root.mkdir(parents=True, exist_ok=True)
    os.chmod(root, stat.S_IRWXU)
    Path(layout["settings_path"]).mkdir(parents=True, exist_ok=True)
    Path(layout["ibc_log_directory"]).mkdir(parents=True, exist_ok=True)

    hostctl.write_atomic(
        layout["ibc_config_path"],
        build_config(
            template,
            port=int(doc["api_port"]),
            trading_mode=doc.get("trading_mode", "paper"),
            username=doc.get("ibkr_username"),
            password=existing_password,
            read_only_login=doc.get("read_only_login", True),
            second_factor_device=doc.get("second_factor_device"),
        ),
    )
    hostctl.write_atomic(
        layout["launcher_path"],
        rewrite_launcher(
            launcher,
            {
                "IBC_INI": layout["ibc_config_path"],
                "LOG_PATH": layout["ibc_log_directory"],
                "TWS_SETTINGS_PATH": layout["settings_path"],
                "TRADING_MODE": doc.get("trading_mode", "paper"),
            },
        ),
        mode=stat.S_IRWXU,
    )
    return layout


def write_unit_template() -> str:
    """Install the `ibkr-gateway@.service` template unit. Blocking.

    One template serves every instance; `%i` is the connection id.
    """
    _require_enabled()
    # systemd names a template unit by its instance-less filename: formatting
    # the configured pattern with an empty instance yields "ibkr-gateway@.service".
    path = Path("/etc/systemd/system") / settings.gateway_instance_unit.format(instance="")
    body = UNIT_TEMPLATE.format(
        root=settings.gateway_instance_root, logs=settings.gateway_log_root
    )
    if path.exists() and path.read_text() == body:
        return str(path)
    hostctl.write_atomic(str(path), body, mode=stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH)
    return str(path)


def remove_files(doc: dict[str, Any]) -> None:
    """Delete a managed instance's directory. Never touches an adopted one."""
    if not doc.get("managed", True):
        return
    shutil.rmtree(instance_root(doc["_id"]), ignore_errors=True)
