from datetime import datetime, timedelta, timezone

import pytest

from app import gateway_login
from app.gateway_login import (
    AUTH_FAILED,
    CONNECTING,
    CONNECTING_STALE,
    DOWN,
    LOGGED_IN,
    STARTING,
    TWO_FACTOR,
    TWO_FACTOR_DEVICE_REQUIRED,
    TWO_FACTOR_EXPIRED,
    evaluate,
)

NOW = datetime(2026, 9, 9, 10, 0, 0, tzinfo=timezone.utc)

def stamp(seconds_ago: int) -> str:
    return (NOW - timedelta(seconds=seconds_ago)).strftime("%Y-%m-%d %H:%M:%S")

def line(seconds_ago: int, text: str) -> str:
    return f"{stamp(seconds_ago)}:000 {text}"

def phase_of(lines, **kwargs):
    return evaluate(
        lines,
        process_active=kwargs.pop("process_active", True),
        port_open=kwargs.pop("port_open", False),
        timeout_seconds=kwargs.pop("timeout_seconds", 180),
        moment=NOW,
        **kwargs,
    )

SESSION = [line(300, "Starting IBC version 3.24.0"), line(299, "Connecting to server")]

def test_open_api_port_outranks_every_log_line():
    progress = phase_of([*SESSION, line(5, "Second Factor Authentication initiated")], port_open=True)
    assert progress.phase == LOGGED_IN
    assert progress.two_factor_remaining_seconds is None

def test_stopped_process_reports_down():
    assert phase_of(SESSION, process_active=False).phase == DOWN

def test_outstanding_push_counts_down_from_the_ibc_timeout():
    progress = phase_of([*SESSION, line(40, "Second Factor Authentication initiated")])
    assert progress.phase == TWO_FACTOR
    assert progress.two_factor_remaining_seconds == 140
    assert progress.two_factor_timeout_seconds == 180
    assert "IBKR Mobile" in progress.message
    assert progress.two_factor_attempts == 1

def test_log_wall_clock_is_resolved_against_the_file_mtime(tmp_path):
    import os

    log = tmp_path / "ibc-3.24.2_GATEWAY-1045_Wednesday.txt"
    written_at = datetime(2026, 9, 9, 10, 0, 0, tzinfo=timezone.utc)
    for label, offset_hours in [("UTC", 0), ("Asia/Kolkata", 5.5), ("US/Eastern", -4)]:
        shifted = written_at + timedelta(hours=offset_hours)
        log.write_text(f"{shifted.strftime('%Y-%m-%d %H:%M:%S')}:000 IBC: last line\n")
        os.utime(log, (written_at.timestamp(), written_at.timestamp()))
        found = gateway_login.log_timezone_offset(log, log.read_text().splitlines())
        assert found == timedelta(hours=offset_hours), f"{label}: got {found}"

def test_timezone_offset_is_ignored_when_it_is_not_a_real_zone(tmp_path):
    import os

    log = tmp_path / "ibc-3.24.2_GATEWAY-1045_Wednesday.txt"
    log.write_text("2020-01-01 00:00:00:000 IBC: ancient line\n")
    os.utime(log, (NOW.timestamp(), NOW.timestamp()))
    assert gateway_login.log_timezone_offset(log, log.read_text().splitlines()) == timedelta(0)

def test_timezone_offset_survives_a_missing_or_unstamped_log(tmp_path):
    assert gateway_login.log_timezone_offset(None, []) == timedelta(0)
    log = tmp_path / "empty.txt"
    log.write_text("no timestamps here\n")
    assert gateway_login.log_timezone_offset(log, ["no timestamps here"]) == timedelta(0)

def test_a_shifted_log_still_counts_down_correctly():
    shifted = [
        f"{(NOW + timedelta(hours=5.5) - timedelta(seconds=s)).strftime('%Y-%m-%d %H:%M:%S')}:000 {text}"
        for s, text in [(300, "IBC: Starting IBC version 3.24.2"),
                        (40, "IBC: Second Factor Authentication initiated")]
    ]
    progress = evaluate(
        shifted, process_active=True, port_open=False, timeout_seconds=180,
        offset=timedelta(hours=5.5), moment=NOW,
    )
    assert progress.phase == TWO_FACTOR
    assert progress.two_factor_remaining_seconds == 140

def test_started_at_carries_a_utc_offset_for_the_browser():
    progress = phase_of([*SESSION, line(40, "Second Factor Authentication initiated")])
    assert progress.two_factor_started_at.utcoffset() is not None
    assert progress.as_dict()["two_factor_started_at"].startswith("2026-09-09T")

def test_expired_push_is_reported_as_expired():
    progress = phase_of([*SESSION, line(200, "Second Factor Authentication initiated")])
    assert progress.phase == TWO_FACTOR_EXPIRED
    assert progress.two_factor_remaining_seconds == 0
    assert "restart" in progress.message.lower()

def test_a_fresh_push_after_an_expired_one_is_live_and_counted():
    progress = phase_of(
        [
            *SESSION,
            line(400, "Second Factor Authentication initiated"),
            line(20, "Second Factor Authentication initiated"),
        ]
    )
    assert progress.phase == TWO_FACTOR
    assert progress.two_factor_remaining_seconds == 160
    assert progress.two_factor_attempts == 2
    assert "Attempt 2" in progress.message

def test_push_from_a_previous_session_is_ignored():
    lines = [
        line(9000, "Second Factor Authentication initiated"),
        line(8900, "Login has completed"),
        line(30, "Connecting to server"),
    ]
    assert phase_of(lines).phase == CONNECTING

def test_a_new_session_start_also_invalidates_an_older_push():
    lines = [
        line(9000, "Second Factor Authentication initiated"),
        line(60, "Starting IBC version 3.24.0"),
        line(30, "Connecting to server"),
    ]
    assert phase_of(lines).phase == CONNECTING

def test_the_dialog_form_ibc_actually_logs_is_recognised():
    lines = [
        *SESSION,
        line(40, "detected dialog entitled: Second Factor Authentication; event=Opened"),
    ]
    progress = phase_of(lines)
    assert progress.phase == TWO_FACTOR
    assert progress.two_factor_remaining_seconds == 140

def test_security_code_card_dialog_is_recognised():
    lines = [*SESSION, line(40, "detected dialog entitled: Security Code Card Authentication")]
    assert phase_of(lines).phase == TWO_FACTOR

def test_one_dialog_is_one_attempt_not_three():
    lines = [
        *SESSION,
        line(40, "detected dialog entitled: Second Factor Authentication; event=Opened"),
        line(40, "detected dialog entitled: Second Factor Authentication; event=Activated"),
        line(40, "detected dialog entitled: Second Factor Authentication; event=Focused"),
        line(39, "Second Factor Authentication initiated"),
    ]
    progress = phase_of(lines)
    assert progress.two_factor_attempts == 1, "one push, not four"
    assert progress.phase == TWO_FACTOR

def test_genuinely_separate_pushes_are_still_counted_apart():
    lines = [
        *SESSION,
        line(200, "Second Factor Authentication initiated"),
        line(40, "Second Factor Authentication initiated"),
    ]
    assert phase_of(lines).two_factor_attempts == 2

def test_unset_device_with_several_enrolled_is_its_own_phase():
    lines = [
        *SESSION,
        line(40, "detected dialog entitled: Second Factor Authentication; event=Opened"),
        line(40, "You should specify the required second factor device using the "
                 "SecondFactorDevice setting in config.ini"),
    ]
    progress = phase_of(lines)
    assert progress.phase == TWO_FACTOR_DEVICE_REQUIRED
    assert "SecondFactorDevice" in progress.message
    assert progress.two_factor_remaining_seconds is None

def test_a_device_warning_from_a_previous_session_is_ignored():
    lines = [
        line(9000, "You should specify the required second factor device"),
        line(300, "Starting IBC version 3.24.0"),
        line(30, "Connecting to server"),
    ]
    assert phase_of(lines).phase == CONNECTING

def test_connecting_elapsed_ignores_a_previous_session():
    lines = [
        line(20000, "Connecting to server"),
        line(60, "Starting IBC version 3.24.0"),
        line(30, "Connecting to server"),
    ]
    progress = phase_of(lines)
    assert progress.phase == CONNECTING
    assert "30s" in progress.message

def test_onstarttokenauth_is_recognised_as_a_push():
    assert phase_of([*SESSION, line(10, "onStartTokenAuth")]).phase == TWO_FACTOR

def test_connecting_reports_elapsed_time():
    progress = phase_of([line(300, "Starting IBC version 3.24.0"), line(30, "Connecting to server")])
    assert progress.phase == CONNECTING
    assert "30s" in progress.message

def test_connecting_too_long_becomes_stale():
    progress = phase_of([line(300, "Starting IBC version 3.24.0"), line(200, "Connecting to server")])
    assert progress.phase == CONNECTING_STALE
    assert "200s" in progress.message

def test_rejected_credentials_report_auth_failure():
    progress = phase_of([*SESSION, line(5, "Authorization failed for user")])
    assert progress.phase == AUTH_FAILED
    assert "credentials" in progress.message

def test_no_logs_yet_reads_as_starting():
    assert phase_of([]).phase == STARTING

def test_exited_gateway_reads_as_down():
    assert phase_of([line(300, "Starting IBC"), line(10, "IBC terminated")]).phase == DOWN
    assert phase_of([line(300, "Starting IBC"), line(10, "GATEWAY has finished")]).phase == DOWN

def test_has_finished_alone_is_not_an_exit():
    progress = phase_of([line(300, "Starting IBC"), line(10, "Market data farm has finished")])
    assert progress.phase == STARTING

def test_launcher_log_timestamps_use_a_dot_separator():
    assert gateway_login.parse_timestamp("2026-09-09 10:00:00.123 launcher line") is not None
    assert gateway_login.parse_timestamp("no timestamp here") is None

@pytest.mark.parametrize(
    ("phase", "remaining", "blocked"),
    [
        (TWO_FACTOR, 140, True),
        (TWO_FACTOR, 30, False),
        (TWO_FACTOR, 5, False),
        (TWO_FACTOR_EXPIRED, 0, False),
        (CONNECTING_STALE, None, False),
        (DOWN, None, False),
    ],
)
def test_restart_is_blocked_only_while_a_push_is_worth_approving(phase, remaining, blocked):
    login = {"login_phase": phase, "two_factor_remaining_seconds": remaining}
    assert gateway_login.restart_blocked(login, grace_seconds=30) is blocked

def test_timeout_is_read_from_the_ibc_config(tmp_path):
    path = tmp_path / "config.ini"
    path.write_text("IbLoginId=apibot\nSecondFactorAuthenticationTimeout=240\n")
    assert gateway_login.read_two_factor_timeout(str(path)) == 240

def test_timeout_falls_back_when_the_config_says_nothing(tmp_path):
    path = tmp_path / "config.ini"
    path.write_text("IbLoginId=apibot\nSecondFactorAuthenticationTimeout=\n")
    assert gateway_login.read_two_factor_timeout(str(path)) == 180
    assert gateway_login.read_two_factor_timeout(str(tmp_path / "absent.ini")) == 180

def test_trading_mode_is_read_from_the_ibc_config(tmp_path):
    path = tmp_path / "config.ini"
    path.write_text("TradingMode=LIVE\n")
    assert gateway_login.read_trading_mode(str(path)) == "live"
    assert gateway_login.read_trading_mode(str(tmp_path / "absent.ini")) == "paper"

def test_collect_lines_prefers_the_newest_gateway_log(tmp_path):
    import os

    older = tmp_path / "ibc-3.24.0_GATEWAY-old.txt"
    newer = tmp_path / "ibc-3.24.0_GATEWAY-new.txt"
    older.write_text("old line\n")
    newer.write_text("new line\n")
    os.utime(older, (1, 1))
    assert gateway_login.collect_lines(str(tmp_path), "") == ["new line"]

def test_collect_lines_survives_a_missing_directory(tmp_path):
    assert gateway_login.collect_lines(str(tmp_path / "absent"), "") == []

def test_tail_reads_only_the_end_of_a_large_log(tmp_path):
    path = tmp_path / "ibc-3.24.0_GATEWAY-big.txt"
    path.write_text("".join(f"line {i}\n" for i in range(200_000)))
    lines = gateway_login.collect_lines(str(tmp_path), "")
    assert lines[-1] == "line 199999"
    assert len(lines) == 300
