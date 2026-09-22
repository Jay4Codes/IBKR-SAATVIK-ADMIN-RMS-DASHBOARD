import app.telegram as telegram


async def configured(monkeypatch):
    monkeypatch.setattr(telegram.settings, "telegram_bot_token", "test-token")
    monkeypatch.setattr(telegram.settings, "telegram_bot_username", "rmsbot")

async def unconfigured(monkeypatch):
    monkeypatch.setattr(telegram.settings, "telegram_bot_token", "")
    monkeypatch.setattr(telegram.settings, "telegram_bot_username", "")

async def test_alerts_report_an_unconfigured_platform_rather_than_failing(
    client, stores, monkeypatch
):
    await unconfigured(monkeypatch)
    body = (await client.get("/api/v1/me/alerts")).json()["data"]
    assert body["configured"] is False
    assert body["linked"] is False
    assert set(body["triggers"]) == set(body["available"]) - {"fills"}

async def test_linking_refuses_when_no_bot_is_configured(client, stores, monkeypatch):
    await unconfigured(monkeypatch)
    assert (await client.post("/api/v1/me/alerts/link")).status_code == 503

async def test_a_link_code_is_one_shot_and_expires(client, stores, monkeypatch):
    await configured(monkeypatch)
    redis, _ = stores
    body = (await client.post("/api/v1/me/alerts/link")).json()["data"]
    assert body["url"].startswith("https://t.me/rmsbot?start=")
    assert body["code"] in body["url"]
    assert await redis.get(f"telegram:link:{body['code']}")
    assert await redis.ttl(f"telegram:link:{body['code']}") > 0

async def test_unknown_triggers_are_dropped_not_rejected(client, stores):
    body = (await client.post("/api/v1/me/alerts", json={
        "triggers": ["fills", "gateway", "teleportation"],
    })).json()["data"]
    assert body["triggers"] == ["fills", "gateway"]
    assert (await client.get("/api/v1/me/alerts")).json()["data"]["triggers"] == ["fills", "gateway"]

async def test_switching_everything_off_is_allowed_and_kept(client, stores):
    body = (await client.post("/api/v1/me/alerts", json={"triggers": []})).json()["data"]
    assert body["triggers"] == []
    assert (await client.get("/api/v1/me/alerts")).json()["data"]["triggers"] == []

async def test_a_malformed_preference_is_a_bad_request(client, stores):
    assert (await client.post("/api/v1/me/alerts", json={"triggers": "fills"})).status_code == 400

async def test_unlinking_leaves_nothing_behind(client, stores, monkeypatch):
    await configured(monkeypatch)
    _, db = stores
    await db.telegram_links.insert_one({"_id": "ADMIN", "chat_id": "42", "name": "jay"})
    assert (await client.get("/api/v1/me/alerts")).json()["data"]["linked"] is True
    body = (await client.delete("/api/v1/me/alerts/link")).json()["data"]
    assert body["linked"] is False
    assert await db.telegram_links.find_one({"_id": "ADMIN"}) is None

async def test_one_persons_link_is_not_another_persons(client, stores, monkeypatch):
    await configured(monkeypatch)
    _, db = stores
    await db.telegram_links.insert_one({"_id": "TRADER", "chat_id": "99", "name": "amit"})
    assert (await client.get("/api/v1/me/alerts")).json()["data"]["linked"] is False
    await client.delete("/api/v1/me/alerts/link")
    assert await db.telegram_links.find_one({"_id": "TRADER"}) is not None

def test_only_a_start_with_a_code_is_a_handshake():
    assert telegram.started_with({"message": {"text": "/start abc123", "chat": {"id": 42, "username": "jay"}}}) == (
        "abc123", "42", "jay",
    )
    assert telegram.started_with({"message": {"text": "/start", "chat": {"id": 42}}}) is None
    assert telegram.started_with({"message": {"text": "hello", "chat": {"id": 42}}}) is None
    assert telegram.started_with({"edited_message": {"text": "/start x", "chat": {"id": 42}}}) is None
    assert telegram.started_with({"message": {"text": "/start x"}}) is None

def test_a_chat_without_a_username_still_gets_a_name():
    found = telegram.started_with(
        {"message": {"text": "/start c", "chat": {"id": 7, "first_name": "Amit", "last_name": "C"}}}
    )
    assert found == ("c", "7", "Amit C")

def test_a_channel_is_recognised_however_the_bot_got_there():
\
\

    assert telegram.group_chat(
        {"channel_post": {"chat": {"id": -1001234, "type": "channel", "title": "RMS Alerts"}}}
    ) == ("-1001234", "RMS Alerts")
    assert telegram.group_chat(
        {"my_chat_member": {"chat": {"id": -1005678, "type": "channel", "title": "RMS Alerts"}}}
    ) == ("-1005678", "RMS Alerts")

def test_a_group_chat_is_recognised_so_its_id_can_be_read_off():

    assert telegram.group_chat(
        {"message": {"chat": {"id": -1002345, "type": "supergroup", "title": "Sattvic Desk"}}}
    ) == ("-1002345", "Sattvic Desk")
    assert telegram.group_chat(
        {"message": {"chat": {"id": -900, "type": "channel"}}}
    ) == ("-900", "-900")

    assert telegram.group_chat({"message": {"chat": {"id": 42, "type": "private"}}}) is None
    assert telegram.group_chat({"message": {}}) is None

def test_an_addressed_start_in_a_group_still_links():

    assert telegram.started_with(
        {"message": {"text": "/start@sattvic_rms_alerts_bot abc123", "chat": {"id": -100, "type": "supergroup"}}}
    ) == ("abc123", "-100", "-100")

async def test_named_move_levels_are_stored_alongside_the_repeating_band(client, stores):

    body = (await client.post("/api/v1/me/alerts", json={
        "triggers": ["move"], "move_levels": ["3", "2", "5"],
    })).json()["data"]
    assert body["move_levels"] == ["2", "3", "5"]

    assert body["move_percent"] == "2.0"

async def test_move_levels_are_magnitudes_and_deduplicated(client, stores):
    body = (await client.post("/api/v1/me/alerts", json={
        "triggers": ["move"], "move_levels": ["-3", "3", "0", "250", "abc", "1.5"],
    })).json()["data"]

    assert body["move_levels"] == ["1.5", "3"]

async def test_the_common_channel_starts_without_entries_and_exits(client, stores, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "telegram_team_chat_id", "-100desk")
    body = (await client.get("/api/v1/me/alerts")).json()["data"]
    assert body["common"]["configured"] is True
    assert body["common"]["triggers"] == ["events", "move", "risk"]
    assert "fills" in body["common"]["available"]
    assert "gateway" not in body["common"]["available"]
    assert "fills" not in body["triggers"]

    saved = (await client.post("/api/v1/me/alerts", json={
        "channel": "common",
        "triggers": ["fills", "move", "gateway"],
        "move_percent": "3",
        "price_levels": ["7800"],
    })).json()["data"]
    assert saved["common"]["triggers"] == ["fills", "move"]
    assert saved["common"]["move_percent"] == "3"
    assert saved["common"]["price_levels"] == ["7800"]
    assert "fills" not in saved["triggers"]
    _, db = stores
    stored = await db.alert_preferences.find_one({"user_id": "__common__"})
    assert stored["triggers"] == ["fills", "move"]
    assert await db.alert_preferences.find_one({"user_id": "ADMIN"}) is None

async def test_common_channel_settings_need_a_configured_chat(client, stores, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "telegram_team_chat_id", "")
    body = (await client.get("/api/v1/me/alerts")).json()["data"]
    assert body["common"] is None
    assert (await client.post(
        "/api/v1/me/alerts", json={"channel": "common", "triggers": ["move"]}
    )).status_code == 404

async def test_move_levels_can_be_cleared(client, stores):
    await client.post("/api/v1/me/alerts", json={"triggers": ["move"], "move_levels": ["3"]})
    body = (await client.post("/api/v1/me/alerts", json={
        "triggers": ["move"], "move_levels": [],
    })).json()["data"]
    assert body["move_levels"] == []
