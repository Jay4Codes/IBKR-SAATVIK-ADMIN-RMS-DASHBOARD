from decimal import Decimal

from app.alerts import band_of, fill_message, terminal_pnl, worst_terminal

BOOK = [
    {"sec_type": "OPT", "strike": "7730", "right": "C", "quantity": "1", "multiplier": "100", "average_cost": "2346.6303"},
    {"sec_type": "OPT", "strike": "7775", "right": "C", "quantity": "1", "multiplier": "100", "average_cost": "1221.6303"},
    {"sec_type": "OPT", "strike": "7510", "right": "P", "quantity": "-2", "multiplier": "100", "average_cost": "2933.8697"},
    {"sec_type": "OPT", "strike": "7485", "right": "P", "quantity": "1", "multiplier": "100", "average_cost": "1229.7303"},
    {"sec_type": "OPT", "strike": "7750", "right": "C", "quantity": "-2", "multiplier": "100", "average_cost": "1773.8697"},
    {"sec_type": "OPT", "strike": "7530", "right": "P", "quantity": "1", "multiplier": "100", "average_cost": "3326.6303"},
]

def cents(value):
    return value.quantize(Decimal("0.01"))

def test_terminal_pnl_agrees_with_the_dashboard_point_for_point():
    spot = Decimal("7656.98")
    assert cents(terminal_pnl(BOOK, spot)) == Decimal("1290.86")
    assert cents(terminal_pnl(BOOK, Decimal("7525"))) == Decimal("1790.86")
    assert cents(terminal_pnl(BOOK, spot * Decimal("0.97"))) == Decimal("790.86")
    assert cents(terminal_pnl(BOOK, spot * Decimal("1.03"))) == Decimal("790.86")

def test_worst_case_is_the_defined_risk_not_an_unbounded_number():
    worst = worst_terminal(BOOK, Decimal("7656.98"))
    assert worst is not None
    assert cents(worst) == Decimal("790.86")
    assert terminal_pnl(BOOK, Decimal("1000")) == terminal_pnl(BOOK, Decimal("2000"))

def test_worst_case_samples_the_corners_a_uniform_grid_steps_over():
    call = [{"sec_type": "OPT", "strike": "7650", "right": "C", "quantity": "1", "multiplier": "100", "average_cost": "4500"}]
    assert worst_terminal(call, Decimal("7656.98")) == Decimal("-4500")

def test_stock_legs_price_off_their_own_cost():
    stock = [{"sec_type": "STK", "quantity": "10", "average_cost": "80", "multiplier": "1"}]
    assert terminal_pnl(stock, Decimal("100")) == Decimal("200")

def test_an_unpriceable_leg_is_skipped_rather_than_guessed_at():
    broken = [
        {"sec_type": "OPT", "strike": None, "right": "C", "quantity": "1", "multiplier": "100", "average_cost": "100"},
        {"sec_type": "FOP", "strike": "100", "right": "C", "quantity": "1", "multiplier": "100", "average_cost": "100"},
        {"sec_type": "OPT", "strike": "100", "right": "", "quantity": "1", "multiplier": "100", "average_cost": "100"},
        {"sec_type": "OPT", "strike": "100", "right": "C", "quantity": "0", "multiplier": "100", "average_cost": "100"},
    ]
    assert terminal_pnl(broken, Decimal("120")) == Decimal(0)
    assert worst_terminal([], Decimal("100")) is not None
    assert worst_terminal(BOOK, Decimal(0)) is None

def test_a_band_only_counts_once_it_is_fully_crossed():
    anchor, step = Decimal("7600"), Decimal(2)
    assert band_of(anchor, anchor, step) == 0
    assert band_of(anchor * Decimal("1.019"), anchor, step) == 0
    assert band_of(anchor * Decimal("1.021"), anchor, step) == 1
    assert band_of(anchor * Decimal("1.041"), anchor, step) == 2
    assert band_of(anchor * Decimal("0.981"), anchor, step) == 0
    assert band_of(anchor * Decimal("0.979"), anchor, step) == -1
    assert band_of(anchor, Decimal(0), step) == 0

def test_a_fill_reports_what_it_booked_only_when_it_booked_something():
    closing = fill_message({
        "account_id": "U22050074",
        "data": {"side": "SLD", "quantity": "1", "symbol": "SPXW  260918P07480000",
                 "price": "11.83", "realized_pnl": "-1265.36"},
    })
    assert "Sold" in closing
    assert "-1,265.36" in closing
    opening = fill_message({
        "account_id": "U22050074",
        "data": {"side": "BOT", "quantity": "1", "symbol": "SPXW  260918P07485000",
                 "price": "12.28", "realized_pnl": "0.0"},
    })
    assert "Bought" in opening
    assert "Booked" not in opening

def test_messages_escape_what_the_broker_sends():
    message = fill_message({"account_id": "<b>x</b>", "data": {"side": "BOT", "symbol": "A&B<c>", "quantity": "1", "price": "1"}})
    assert "&lt;" in message and "&amp;" in message
    assert "<b>x</b>" not in message

def test_a_restart_looks_exactly_like_an_outage_at_the_instant_it_happens():
\
\
\
\

    from app.alerts import GATEWAY_DEBOUNCED, GATEWAY_URGENT

    assert "DISCONNECTED" in GATEWAY_DEBOUNCED
    assert "DEGRADED" in GATEWAY_DEBOUNCED

    assert "TWO_FACTOR_PENDING" in GATEWAY_URGENT
    assert "FAILED" in GATEWAY_URGENT
    assert not set(GATEWAY_DEBOUNCED) & set(GATEWAY_URGENT)

def test_a_recovery_says_how_long_it_was_gone():
    from app.alerts import recovery_message

    assert "back after 45s" in recovery_message("Primary IB Gateway", "DISCONNECTED", 45)
    assert "back after 4 min" in recovery_message("Primary IB Gateway", "DISCONNECTED", 240)
    assert "Primary IB Gateway" in recovery_message("Primary IB Gateway", "DEGRADED", 100)

def test_a_members_own_threshold_wins_over_the_platform_default():
    from app.alerts import threshold

    assert threshold(None, "move_percent") == Decimal("2.0")
    assert threshold({}, "move_percent") == Decimal("2.0")
    assert threshold({"move_percent": "5"}, "move_percent") == Decimal("5")
    assert threshold({"risk_percent": "25"}, "risk_percent") == Decimal("25")

    assert threshold({"move_percent": "0"}, "move_percent") == Decimal("2.0")
    assert threshold({"move_percent": "900"}, "move_percent") == Decimal("2.0")
    assert threshold({"move_percent": "nonsense"}, "move_percent") == Decimal("2.0")

def test_a_price_level_fires_on_the_crossing_not_on_the_side():
    from app.alerts import crossed

    assert crossed(Decimal("7790"), Decimal("7801"), Decimal("7800"))

    assert crossed(Decimal("7810"), Decimal("7799"), Decimal("7800"))

    assert not crossed(Decimal("7810"), Decimal("7820"), Decimal("7800"))
    assert not crossed(Decimal("7790"), Decimal("7795"), Decimal("7800"))

    assert crossed(Decimal("7790"), Decimal("7800"), Decimal("7800"))
    assert not crossed(Decimal("7800"), Decimal("7805"), Decimal("7800"))

def test_a_price_crossing_says_which_way_it_went():
    from app.alerts import price_message

    up = price_message("SPX", Decimal("7801"), Decimal("7800"), True)
    assert "▲" in up and "7,800.00" in up and "7,801.00" in up
    assert "▼" in price_message("SPX", Decimal("7799"), Decimal("7800"), False)
