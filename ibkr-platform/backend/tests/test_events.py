"""Days that are not like other days, and the parsing that finds them."""

from app.events import decision_day, describe, seed_releases, upcoming, valid_day


def test_a_meeting_is_dated_by_the_day_its_decision_lands():
    # The statement comes on the second day; that is the one the desk trades.
    assert decision_day(2026, "September", "15-16*") == "2026-09-16"
    assert decision_day(2026, "January", "27-28") == "2026-01-28"
    # The asterisk marks a press conference and is not part of the date.
    assert decision_day(2026, "March", "17-18*") == "2026-03-18"


def test_a_meeting_that_straddles_two_months_closes_in_the_second():
    assert decision_day(2025, "January/February", "28-1") == "2025-02-01"
    # Even when the page names only the opening month.
    assert decision_day(2025, "April", "30-1") == "2025-05-01"
    # And across a year end.
    assert decision_day(2025, "December", "31-1") == "2026-01-01"


def test_a_single_day_meeting_is_its_own_decision_day():
    assert decision_day(2026, "June", "17") == "2026-06-17"


def test_nonsense_is_skipped_rather_than_guessed_at():
    assert decision_day(2026, "Smarch", "15-16") is None
    assert decision_day(2026, "September", "") is None
    assert decision_day(2026, "", "15-16") is None
    # 31 September does not exist, and inventing 1 October would be worse.
    assert decision_day(2026, "September", "30-31") is None


def test_upcoming_looks_forward_only_and_in_order():
    events = [
        {"date": "2026-09-16", "kind": "fomc"},
        {"date": "2026-09-10", "kind": "holiday"},
        {"date": "2026-09-25", "kind": "holiday"},
        {"date": "2027-01-01", "kind": "holiday"},
        {"date": "not-a-date", "kind": "holiday"},
    ]
    found = upcoming(events, "2026-09-16", days=14)
    assert [e["date"] for e in found] == ["2026-09-16", "2026-09-25"]
    # Today counts as upcoming: an FOMC afternoon is not yesterday's problem.
    assert found[0]["kind"] == "fomc"
    assert upcoming(events, "nonsense") == []


def test_a_half_day_reads_differently_from_a_closure():
    assert "market closed" in describe(
        {"kind": "holiday", "name": "Christmas", "hours": ""}
    )
    # The hours matter: the desk can trade a half day, and its options expire early.
    assert "09:30-13:00" in describe(
        {"kind": "half_day", "name": "Thanksgiving Day", "hours": "09:30-13:00"}
    )
    assert describe({"kind": "fomc", "name": "FOMC decision"}) == "FOMC decision day"


def test_hand_seeded_releases_are_marked_as_hand_seeded():
    rows = seed_releases([("2026-10-13", "CPI"), ("bad", "CPI")])
    assert len(rows) == 1
    # Provenance is kept so a typed date is never mistaken for an attested one.
    assert rows[0]["source"] == "manual"
    assert rows[0]["kind"] == "release"


def test_valid_day_rejects_dates_that_do_not_exist():
    assert valid_day("2026-09-16")
    assert not valid_day("2026-02-30")
    assert not valid_day("2026-9-16")
    assert not valid_day("")


def test_an_event_day_message_leads_with_today_then_what_is_coming():
    from app.alerts import events_message

    today = [{"date": "2026-09-16", "kind": "fomc", "name": "FOMC decision", "hours": ""}]
    ahead = today + [
        {"date": "2026-11-26", "kind": "holiday", "name": "Thanksgiving Day", "hours": ""},
        {"date": "2026-11-27", "kind": "half_day", "name": "Thanksgiving Day", "hours": "09:30-13:00"},
    ]
    message = events_message("2026-09-16", today, ahead)
    assert "Event day — 2026-09-16" in message
    assert "FOMC decision day" in message
    assert "Coming up" in message
    assert "09:30-13:00" in message
    # Today is not repeated under "coming up".
    assert message.count("2026-09-16") == 1


def test_a_quiet_day_still_renders_without_a_coming_up_block():
    from app.alerts import events_message

    today = [{"date": "2026-12-25", "kind": "holiday", "name": "Christmas", "hours": ""}]
    assert "Coming up" not in events_message("2026-12-25", today, today)


def test_event_names_from_a_feed_are_escaped():
    from app.alerts import events_message

    nasty = [{"date": "2026-09-16", "kind": "holiday", "name": "<b>Bad</b> & co", "hours": ""}]
    message = events_message("2026-09-16", nasty, nasty)
    assert "&lt;b&gt;" in message and "&amp;" in message
