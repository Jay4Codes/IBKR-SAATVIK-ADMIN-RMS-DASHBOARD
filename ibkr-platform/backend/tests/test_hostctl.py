import os
import stat

import pytest

from app import hostctl

TEMPLATE = """# IBC configuration
IbLoginId=olduser
IbPassword=oldsecret
TradingMode=paper
OverrideTwsApiPort=4002
OverrideTwsMasterClientID=17
ReadOnlyApi=yes
"""

@pytest.fixture
def config(tmp_path):
    path = tmp_path / "config.ini"
    path.write_text(TEMPLATE)
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    return str(path)

def test_write_credentials_replaces_only_login_fields(config):
    hostctl.write_credentials(config, "newuser", "s3cret-value", "live", 4001)
    text = open(config).read()
    assert "IbLoginId=newuser" in text
    assert "IbPassword=s3cret-value" in text
    assert "TradingMode=live" in text
    assert "OverrideTwsApiPort=4001" in text
    assert "OverrideTwsMasterClientID=17" in text
    assert "ReadOnlyApi=yes" in text
    assert text.count("IbLoginId=") == 1
    assert text.count("IbPassword=") == 1
    assert "olduser" not in text and "oldsecret" not in text

def test_write_credentials_keeps_file_private(config):
    hostctl.write_credentials(config, "newuser", "s3cret-value", "live", 4001)
    mode = stat.S_IMODE(os.stat(config).st_mode)
    assert mode == 0o600, oct(mode)

def test_write_credentials_is_atomic_and_leaves_no_temp_files(config, tmp_path):
    hostctl.write_credentials(config, "newuser", "s3cret-value", "live", 4001)
    leftovers = [p for p in os.listdir(tmp_path) if p != "config.ini"]
    assert leftovers == []

def test_credentials_never_advertise_a_read_only_login_on_gateway(config):
    with open(config, "a") as handle:
        handle.write("ReadOnlyLogin=yes\n")
    hostctl.write_credentials(config, "apibot", "pw", "live", 4001)
    text = open(config).read()
    assert "ReadOnlyLogin=no" in text
    assert "ReadOnlyLogin=yes" not in text
    assert "SecondFactorDevice" not in text

def test_second_factor_device_is_optional(config):
    hostctl.write_credentials(config, "apibot", "pw", "live", 4001, second_factor_device="IB Key")
    assert "SecondFactorDevice=IB Key" in open(config).read()

def test_read_username_returns_only_the_username(config):
    assert hostctl.read_username(config) == "olduser"
    hostctl.write_credentials(config, "apibot", "s3cret-value", "live", 4001)
    assert hostctl.read_username(config) == "apibot"

def test_read_username_handles_missing_or_unset_path(tmp_path):
    assert hostctl.read_username(str(tmp_path / "absent.ini")) is None
    assert hostctl.read_username(None) is None

def test_missing_keys_are_appended(tmp_path):
    path = tmp_path / "sparse.ini"
    path.write_text("# empty config\n")
    hostctl.write_credentials(str(path), "apibot", "s3cret-value", "paper", 4002)
    text = path.read_text()
    for expected in ("IbLoginId=apibot", "IbPassword=s3cret-value", "TradingMode=paper"):
        assert expected in text

async def test_process_action_rejects_unknown_action():
    with pytest.raises(ValueError):
        await hostctl.process_action("destroy", "ibkr-gateway.service")

@pytest.mark.parametrize(
    "action, expected",
    [
        ("start", [("reset-failed",), ("start",), ("is-active",)]),
        ("restart", [("reset-failed",), ("restart",), ("is-active",)]),
        ("stop", [("stop",), ("is-active",)]),
    ],
)
async def test_process_action_clears_start_limit_before_starting(monkeypatch, action, expected):
    calls = []

    async def fake_systemctl(*args):
        calls.append(args[:-1])
        return 0, "active"

    monkeypatch.setattr(hostctl, "_systemctl", fake_systemctl)
    assert await hostctl.process_action(action, "ibkr-gateway.service") == "active"
    assert calls == expected
