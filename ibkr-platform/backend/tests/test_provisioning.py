import os
import stat
from pathlib import Path

import pytest
from fastapi import HTTPException

from app import provisioning
from app.config import settings

CONFIG_TEMPLATE = """# IBC configuration
IbLoginId=template-user
IbPassword=template-secret
TradingMode=live
OverrideTwsApiPort=4001
ReadOnlyLogin=no
SecondFactorDevice=
TrustedTwsApiClientIPs=10.0.0.1
"""

LAUNCHER_TEMPLATE = """#!/bin/bash
TWS_MAJOR_VRSN=1045
IBC_INI=/opt/ibc/config.ini
TRADING_MODE=
IBC_PATH=/opt/ibc
TWS_PATH=/root/Jts
TWS_SETTINGS_PATH=
LOG_PATH=/var/log/ibc

exec java -jar "$IBC_PATH/IBC.jar"
"""

@pytest.fixture
def host(tmp_path, monkeypatch):
    ibc = tmp_path / "ibc"
    ibc.mkdir()
    (ibc / "config.ini").write_text(CONFIG_TEMPLATE)
    (ibc / "gatewaystart.sh").write_text(LAUNCHER_TEMPLATE)
    monkeypatch.setattr(settings, "gateway_template_config", str(ibc / "config.ini"))
    monkeypatch.setattr(settings, "gateway_instance_root", str(tmp_path / "instances"))
    monkeypatch.setattr(settings, "gateway_log_root", str(tmp_path / "logs"))
    monkeypatch.setattr(settings, "gateway_provisioning_enabled", True)
    return tmp_path

def connection(**overrides):
    return {
        "_id": "conn-1",
        "api_port": 4137,
        "trading_mode": "paper",
        "ibkr_username": None,
        **overrides,
    }

def test_paths_are_derived_from_the_connection_id(host):
    layout = provisioning.paths("conn-1")
    assert layout["ibc_config_path"].endswith("instances/conn-1/config.ini")
    assert layout["ibc_log_directory"].endswith("logs/conn-1")
    assert layout["service_unit"] == "ibkr-gateway@conn-1.service"

def test_provisioning_creates_a_private_isolated_instance(host):
    layout = provisioning.provision_files(connection())
    config = Path(layout["ibc_config_path"])
    assert stat.S_IMODE(os.stat(config).st_mode) == 0o600
    assert Path(layout["settings_path"]).is_dir()
    assert Path(layout["ibc_log_directory"]).is_dir()

    text = config.read_text()
    assert "OverrideTwsApiPort=4137" in text
    assert "TradingMode=paper" in text
    assert "ExistingSessionDetectedAction=primary" in text
    assert "IbLoginId=" in text and "template-user" not in text
    assert "template-secret" not in text

def test_the_launcher_points_at_this_instances_own_files(host):
    layout = provisioning.provision_files(connection())
    launcher = Path(layout["launcher_path"]).read_text()
    assert f"IBC_INI={layout['ibc_config_path']}" in launcher
    assert f"LOG_PATH={layout['ibc_log_directory']}" in launcher
    assert f"TWS_SETTINGS_PATH={layout['settings_path']}" in launcher
    assert "TRADING_MODE=paper" in launcher
    assert "IBC_INI=/opt/ibc/config.ini" not in launcher
    assert "TWS_PATH=/root/Jts" in launcher
    assert "TWS_MAJOR_VRSN=1045" in launcher
    assert stat.S_IMODE(os.stat(layout["launcher_path"]).st_mode) == 0o700

def test_the_worker_is_master_client_of_its_own_gateway(host):
    template_id = "OverrideTwsMasterClientID=17\n"
    (host / "ibc" / "config.ini").write_text(CONFIG_TEMPLATE + template_id)
    text = Path(provisioning.provision_files(connection(client_id=18))["ibc_config_path"]).read_text()
    assert "OverrideTwsMasterClientID=18" in text
    assert template_id not in text

def test_two_connections_get_fully_separate_instances(host):
    first = provisioning.provision_files(connection(_id="a", api_port=4101))
    second = provisioning.provision_files(connection(_id="b", api_port=4102))
    assert first["ibc_config_path"] != second["ibc_config_path"]
    assert first["settings_path"] != second["settings_path"]
    assert first["ibc_log_directory"] != second["ibc_log_directory"]
    assert "OverrideTwsApiPort=4101" in Path(first["ibc_config_path"]).read_text()
    assert "OverrideTwsApiPort=4102" in Path(second["ibc_config_path"]).read_text()

def test_reprovisioning_keeps_the_password_already_on_disk(host):
    layout = provisioning.provision_files(connection(), password="live-secret")
    assert "IbPassword=live-secret" in Path(layout["ibc_config_path"]).read_text()
    provisioning.provision_files(connection(api_port=4200))
    text = Path(layout["ibc_config_path"]).read_text()
    assert "IbPassword=live-secret" in text
    assert "OverrideTwsApiPort=4200" in text

def test_a_provisioned_gateway_needs_one_push_a_week_not_one_a_night(host):
    text = Path(provisioning.provision_files(connection())["ibc_config_path"]).read_text()
    assert "AutoRestartTime=03:00 AM" in text
    assert "AutoLogoffTime=\n" in text
    assert "ColdRestartTime=13:30" in text
    assert "ReloginAfterSecondFactorAuthenticationTimeout=no" in text
    assert "ExitAfterSecondFactorAuthenticationTimeout=no" in text
    assert "ReadOnlyLogin=no" in text
    assert "ReadOnlyApi=yes" in text

def test_the_restart_schedule_is_operator_configurable(host, monkeypatch):
    monkeypatch.setattr(settings, "gateway_auto_restart_time", "11:45 PM")
    monkeypatch.setattr(settings, "gateway_cold_restart_time", "07:05")
    text = Path(provisioning.provision_files(connection())["ibc_config_path"]).read_text()
    assert "AutoRestartTime=11:45 PM" in text
    assert "ColdRestartTime=07:05" in text

@pytest.mark.parametrize("bad", ["05:00", "3:00 AM", "03:00AM", "13:00 PM", "03:00 am", ""])
def test_a_restart_time_ibc_would_reject_is_refused_up_front(host, monkeypatch, bad):
    monkeypatch.setattr(settings, "gateway_auto_restart_time", bad)
    with pytest.raises(HTTPException) as error:
        provisioning.provision_files(connection())
    assert error.value.status_code == 503
    assert "GATEWAY_AUTO_RESTART_TIME" in error.value.detail

def test_a_malformed_cold_restart_time_is_refused(host, monkeypatch):
    monkeypatch.setattr(settings, "gateway_cold_restart_time", "1:30 PM")
    with pytest.raises(HTTPException) as error:
        provisioning.provision_files(connection())
    assert "GATEWAY_COLD_RESTART_TIME" in error.value.detail

def test_the_unit_restarts_clean_exits_but_not_in_a_tight_loop(host, monkeypatch):
    written = {}
    monkeypatch.setattr(provisioning.hostctl, "write_atomic", lambda p, t, mode=0: written.__setitem__(p, t))
    body = written[provisioning.write_unit_template()]
    assert "Restart=always" in body
    assert "RestartSec=60" in body
    assert "StartLimitIntervalSec=3600" in body
    assert "StartLimitBurst=5" in body

def test_the_unit_template_is_written_once_and_is_idempotent(host, tmp_path, monkeypatch):
    written = {}

    def fake_write(path, text, mode=0):
        written[path] = text

    monkeypatch.setattr(provisioning.hostctl, "write_atomic", fake_write)
    path = provisioning.write_unit_template()
    assert path.endswith("ibkr-gateway@.service")
    body = written[path]
    assert "ExecStart=/usr/bin/xvfb-run -a" in body
    assert f"{settings.gateway_instance_root}/%i/gatewaystart.sh" in body
    assert "WantedBy=multi-user.target" in body

def test_provisioning_is_refused_when_disabled(host, monkeypatch):
    monkeypatch.setattr(settings, "gateway_provisioning_enabled", False)
    with pytest.raises(HTTPException) as error:
        provisioning.provision_files(connection())
    assert error.value.status_code == 503
    assert "provisioning is disabled" in error.value.detail

def test_a_missing_ibc_installation_reports_where_to_look(host, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "gateway_template_config", str(tmp_path / "absent.ini"))
    with pytest.raises(HTTPException) as error:
        provisioning.provision_files(connection())
    assert error.value.status_code == 503
    assert "GATEWAY_TEMPLATE_CONFIG" in error.value.detail

def test_removing_files_never_touches_an_adopted_instance(host):
    layout = provisioning.provision_files(connection())
    provisioning.remove_files({"_id": "conn-1", "managed": False})
    assert Path(layout["ibc_config_path"]).exists()
    provisioning.remove_files({"_id": "conn-1", "managed": True})
    assert not Path(layout["ibc_config_path"]).exists()
