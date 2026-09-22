"""Whether a gateway transition is worth waking anyone for.

The bug these cover: three deploys in one afternoon each bounced the broker
session for about two seconds, and each one reached the desk as a disconnect
alert followed by a reconnect alert. Six interruptions, nothing to act on.
"""

import app.alerts as alerts
from app.worker import AlertDispatcher


class FakeRedis:
    """Just enough Redis for the idempotence markers."""

    def __init__(self):
        self.store: dict[str, str] = {}

    async def set(self, key, value, ex=None, nx=False):
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True

    async def get(self, key):
        return self.store.get(key)


def dispatcher(monkeypatch, grace=60, redis=None):
    monkeypatch.setattr(alerts, "GATEWAY_REPORTED", alerts.GATEWAY_REPORTED)
    from app.config import settings

    monkeypatch.setattr(settings, "alert_gateway_grace_seconds", grace)
    sent = []
    worker = AlertDispatcher(redis or FakeRedis(), None, "t1")

    async def deliver(client, trigger, account, text, urgent=False):
        sent.append({"trigger": trigger, "text": text, "urgent": urgent})

    worker.deliver = deliver
    return worker, sent


async def test_a_two_second_restart_says_nothing_at_all(monkeypatch):
    worker, sent = dispatcher(monkeypatch)
    clock = [1000.0]
    monkeypatch.setattr("app.worker.time.time", lambda: clock[0])

    await worker.gateway_changed(None, "c1", "Primary IB Gateway", "DISCONNECTED", None)
    clock[0] += 2
    await worker.sweep_pending(None)          # still inside the grace period
    await worker.gateway_changed(None, "c1", "Primary IB Gateway", "CONNECTED", None)
    clock[0] += 300
    await worker.sweep_pending(None)

    assert sent == []
    assert worker.state.pending == {}


async def test_an_outage_that_lasts_is_reported_once_and_then_closed(monkeypatch):
    worker, sent = dispatcher(monkeypatch)
    clock = [1000.0]
    monkeypatch.setattr("app.worker.time.time", lambda: clock[0])

    await worker.gateway_changed(None, "c1", "Primary IB Gateway", "DISCONNECTED", "socket closed")
    assert sent == []                          # nothing yet: it may still heal
    clock[0] += 61
    await worker.sweep_pending(None)
    assert len(sent) == 1
    assert "Disconnected" in sent[0]["text"]
    assert sent[0]["urgent"] is True

    # Repeated disconnects while already reported must not pile up.
    await worker.gateway_changed(None, "c1", "Primary IB Gateway", "DISCONNECTED", None)
    clock[0] += 120
    await worker.sweep_pending(None)
    assert len(sent) == 1

    clock[0] += 60
    await worker.gateway_changed(None, "c1", "Primary IB Gateway", "CONNECTED", None)
    assert len(sent) == 2
    assert "Recovered" in sent[1]["text"]
    # It reports how long it was actually gone, measured from the first sighting.
    assert "4 min" in sent[1]["text"]


async def test_a_recovery_is_silent_when_nothing_was_ever_reported(monkeypatch):
    worker, sent = dispatcher(monkeypatch)
    monkeypatch.setattr("app.worker.time.time", lambda: 1000.0)
    await worker.gateway_changed(None, "c1", "Primary IB Gateway", "CONNECTED", None)
    assert sent == []


async def test_a_login_prompt_cannot_wait_for_a_grace_period(monkeypatch):
    # Two-factor expires in 180 seconds; holding it 60 would burn a third of
    # the only window the account holder has to answer.
    worker, sent = dispatcher(monkeypatch)
    monkeypatch.setattr("app.worker.time.time", lambda: 1000.0)
    await worker.gateway_changed(None, "c1", "Primary IB Gateway", "TWO_FACTOR_PENDING", None)
    assert len(sent) == 1
    assert sent[0]["urgent"] is True
    # And it is not repeated while it stays pending.
    await worker.gateway_changed(None, "c1", "Primary IB Gateway", "TWO_FACTOR_PENDING", None)
    assert len(sent) == 1


async def test_a_farm_blip_that_clears_itself_stays_quiet(monkeypatch):
    worker, sent = dispatcher(monkeypatch)
    clock = [1000.0]
    monkeypatch.setattr("app.worker.time.time", lambda: clock[0])
    for _ in range(4):
        await worker.gateway_changed(None, "c1", "Primary IB Gateway", "DEGRADED", "farm broken")
        clock[0] += 5
        await worker.gateway_changed(None, "c1", "Primary IB Gateway", "CONNECTED", None)
        clock[0] += 5
    await worker.sweep_pending(None)
    assert sent == []


async def test_two_gateways_are_tracked_apart(monkeypatch):
    worker, sent = dispatcher(monkeypatch)
    clock = [1000.0]
    monkeypatch.setattr("app.worker.time.time", lambda: clock[0])
    await worker.gateway_changed(None, "c1", "Primary", "DISCONNECTED", None)
    await worker.gateway_changed(None, "c2", "Secondary", "DISCONNECTED", None)
    clock[0] += 3
    await worker.gateway_changed(None, "c1", "Primary", "CONNECTED", None)
    clock[0] += 61
    await worker.sweep_pending(None)
    # Only the one that stayed down is reported.
    assert len(sent) == 1
    assert "Secondary" in sent[0]["text"]


async def test_one_overnight_outage_is_one_alert_not_a_pair_every_two_minutes(monkeypatch):
    """The real 3am storm: the retry loop publishes DISCONNECTED then FAILED on
    every attempt, so tracking the last *status* made each alternation look like
    news. Eight hours of that is roughly two hundred and forty alerts."""
    worker, sent = dispatcher(monkeypatch)
    clock = [1000.0]
    monkeypatch.setattr("app.worker.time.time", lambda: clock[0])

    await worker.gateway_changed(None, "c1", "Primary IB Gateway", "DISCONNECTED", "Errno 111")
    clock[0] += 61
    await worker.sweep_pending(None)
    assert len(sent) == 1

    # Eight hours of the retry loop alternating between the two spellings.
    for _ in range(240):
        clock[0] += 60
        await worker.gateway_changed(None, "c1", "Primary IB Gateway", "FAILED", "Errno 111")
        clock[0] += 60
        await worker.gateway_changed(None, "c1", "Primary IB Gateway", "DISCONNECTED", "Errno 111")
        await worker.sweep_pending(None)

    assert len(sent) == 1, f"one outage should be one alert, got {len(sent)}"

    # And it still closes properly when the gateway comes back in the morning.
    await worker.gateway_changed(None, "c1", "Primary IB Gateway", "CONNECTED", None)
    assert len(sent) == 2
    assert "Recovered" in sent[1]["text"]


async def test_a_login_prompt_during_an_outage_still_gets_through(monkeypatch):
    """Escalation is different information, not a repeat: nobody can act on a
    disconnect, but a two-factor prompt is a phone that needs answering."""
    worker, sent = dispatcher(monkeypatch)
    clock = [1000.0]
    monkeypatch.setattr("app.worker.time.time", lambda: clock[0])

    await worker.gateway_changed(None, "c1", "Primary IB Gateway", "DISCONNECTED", None)
    clock[0] += 61
    await worker.sweep_pending(None)
    assert len(sent) == 1

    await worker.gateway_changed(None, "c1", "Primary IB Gateway", "TWO_FACTOR_PENDING", None)
    assert len(sent) == 2
    assert "Two Factor" in sent[1]["text"]
    # …but not twice.
    await worker.gateway_changed(None, "c1", "Primary IB Gateway", "TWO_FACTOR_PENDING", None)
    assert len(sent) == 2


async def test_reconnecting_is_part_of_being_down_not_a_recovery(monkeypatch):
    worker, sent = dispatcher(monkeypatch)
    clock = [1000.0]
    monkeypatch.setattr("app.worker.time.time", lambda: clock[0])
    await worker.gateway_changed(None, "c1", "Primary IB Gateway", "DISCONNECTED", None)
    clock[0] += 61
    await worker.sweep_pending(None)
    await worker.gateway_changed(None, "c1", "Primary IB Gateway", "RECONNECTING", None)
    await worker.gateway_changed(None, "c1", "Primary IB Gateway", "CONNECTING", None)
    # Trying again is not being back; only CONNECTED closes an outage.
    assert len(sent) == 1


async def test_an_empty_calendar_does_not_count_as_a_quiet_day(monkeypatch):
    """The dispatcher starts before the first calendar fetch lands.

    Marking the day announced on that first empty pass suppressed a real event
    day for the whole of it — which is exactly what happened on an FOMC morning.
    """

    class Cursor:
        def __init__(self, rows):
            self.rows = rows

        def sort(self, *a, **k):
            return self

        async def to_list(self, n):
            return self.rows

    class Collection:
        def __init__(self):
            self.rows = []

        def find(self, *a, **k):
            return Cursor(self.rows)

    class Db:
        def __init__(self):
            self.market_events = Collection()

    worker, sent = dispatcher(monkeypatch)
    worker.db = Db()

    # First pass: the refresh has not run, so nothing is known yet.
    await worker.announce_events(None)
    assert sent == []
    assert worker.state.announced == ""

    # The refresh lands, and the day is announced on the next pass.
    worker.db.market_events.rows = [
        {"date": "2026-09-16", "kind": "fomc", "name": "FOMC decision", "hours": ""},
    ]
    monkeypatch.setattr(
        "app.worker.now",
        lambda: __import__("datetime").datetime(2026, 9, 16, 15, 0, tzinfo=__import__("datetime").UTC),
    )
    await worker.announce_events(None)
    assert len(sent) == 1
    assert "FOMC decision day" in sent[0]["text"]

    # …and only once.
    await worker.announce_events(None)
    assert len(sent) == 1


async def test_a_restart_does_not_replay_the_days_fills(monkeypatch):
    """The worker re-requests the day's executions whenever it reconnects.

    The guard that stopped it republishing them lived in memory, so every
    deploy replayed every fill as a fresh alert — six of them, twice, five
    minutes apart, in the desk's channel.
    """
    worker, sent = dispatcher(monkeypatch)
    event = {
        "event_type": "execution.created",
        "account_id": "U1",
        "data": {"execution_id": "x1", "side": "BOT", "quantity": "1",
                 "symbol": "SPXW  260930P07575000", "price": "12.00"},
    }

    await worker.handle(None, event)
    assert len(sent) == 1

    # The same execution arriving again — a reconnect, a redeploy, a retry.
    await worker.handle(None, event)
    await worker.handle(None, event)
    assert len(sent) == 1

    # A genuinely different fill still gets through.
    await worker.handle(None, {**event, "data": {**event["data"], "execution_id": "x2"}})
    assert len(sent) == 2


async def test_a_restart_mid_outage_does_not_re_report_it(monkeypatch):
    worker, sent = dispatcher(monkeypatch)
    clock = [1000.0]
    monkeypatch.setattr("app.worker.time.time", lambda: clock[0])

    await worker.gateway_changed(None, "c1", "Primary IB Gateway", "DISCONNECTED", None)
    clock[0] += 61
    await worker.sweep_pending(None)
    assert len(sent) == 1

    # A redeploy: fresh in-memory state, same Redis, same ongoing outage.
    restarted, resent = dispatcher(monkeypatch, redis=worker.redis)
    await restarted.gateway_changed(None, "c1", "Primary IB Gateway", "DISCONNECTED", None)
    clock[0] += 61
    await restarted.sweep_pending(None)
    assert resent == []

    # …and the recovery still closes the episode the first worker opened.
    await restarted.gateway_changed(None, "c1", "Primary IB Gateway", "CONNECTED", None)
    assert len(resent) == 1
    assert "Recovered" in resent[0]["text"]


async def test_a_login_waiting_on_a_phone_is_reported_as_such(monkeypatch):
    """The 86-hour outage: 513 "disconnected" alerts, not one saying why.

    While two-factor is pending the API socket is simply down, so classifying
    on socket status alone repeated the symptom and never named the cause —
    which was the only thing anyone could have acted on.
    """
    worker, sent = dispatcher(monkeypatch)
    monkeypatch.setattr("app.worker.time.time", lambda: 1000.0)

    await worker.gateway_changed(
        None, "c1", "Primary IB Gateway", "DISCONNECTED", "Errno 111", "two_factor",
    )
    assert len(sent) == 1
    assert sent[0]["urgent"] is True
    assert "two-factor approval" in sent[0]["text"]
    # Not the generic disconnect wording it used to send.
    assert "Errno 111" not in sent[0]["text"]

    # It does not repeat while the prompt stays open.
    await worker.gateway_changed(
        None, "c1", "Primary IB Gateway", "FAILED", "Errno 111", "two_factor",
    )
    assert len(sent) == 1


async def test_each_login_problem_says_what_it_actually_is(monkeypatch):
    from app.alerts import login_message

    assert "expired" in login_message("G", "two_factor_expired")
    assert "no two-factor device" in login_message("G", "two_factor_device_required")
    assert "rejected" in login_message("G", "auth_failed")
