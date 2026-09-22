import base64
import hashlib
import hmac
import json

import pytest
from fastapi import HTTPException

from app import secrets, snaptrade
from app.config import settings


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    monkeypatch.setattr(settings, "snaptrade_client_id", "test-client")
    monkeypatch.setattr(settings, "snaptrade_consumer_key", "test-consumer-key")

def test_signature_matches_snaptrades_canonical_form():
    query = {"clientId": "test-client", "timestamp": "1700000000", "userId": "u1"}
    signature = snaptrade.sign("/accounts", query, None)
    expected_content = json.dumps(
        {
            "content": None,
            "path": "/accounts",
            "query": "clientId=test-client&timestamp=1700000000&userId=u1",
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    expected = base64.urlsafe_b64encode(
        hmac.new(b"test-consumer-key", expected_content.encode(), hashlib.sha256).digest()
    ).decode()
    assert signature == expected

def test_the_signature_covers_the_body():
    query = {"clientId": "test-client", "timestamp": "1"}
    assert snaptrade.sign("/x", query, {"a": 1}) != snaptrade.sign("/x", query, {"a": 2})

def test_provider_reports_itself_unconfigured(monkeypatch):
    monkeypatch.setattr(settings, "snaptrade_client_id", "")
    assert not snaptrade.configured()
    with pytest.raises(HTTPException) as error:
        snaptrade.require_configured()
    assert error.value.status_code == 503

async def test_an_unregistered_connection_cannot_make_a_user_call():
    async with snaptrade.SnapTradeClient() as client:
        with pytest.raises(HTTPException) as error:
            await client.accounts()
    assert error.value.status_code == 409
    assert "not been registered" in error.value.detail

def test_positions_are_normalised_with_derived_valuations():
    row = {
        "symbol": {
            "symbol": {
                "id": "sym-1",
                "symbol": "MSFT",
                "description": "Microsoft Corp",
                "type": {"code": "cs"},
                "currency": {"code": "USD"},
                "exchange": {"code": "NASDAQ"},
            }
        },
        "units": "10",
        "price": "400.50",
        "average_purchase_price": "380.00",
    }
    position = snaptrade.normalize_position("U1", row)
    assert position.symbol == "MSFT"
    assert position.sec_type == "CS"
    assert position.currency == "USD"
    assert str(position.market_value) == "4005.00"
    assert str(position.unrealized_pnl) == "205.00"
    assert position.con_id > 0

def test_a_position_without_a_price_leaves_valuations_blank():
    position = snaptrade.normalize_position("U1", {"symbol": "AAPL", "units": "3", "price": None})
    assert position.market_price is None
    assert position.market_value is None
    assert position.unrealized_pnl is None

def test_account_normalisation_leaves_unreported_margin_fields_blank():
    account = snaptrade.normalize_account(
        {"number": "U1", "balance": {"total": {"amount": "1250.75", "currency": "USD"}}},
        [{"currency": {"code": "USD"}, "cash": "300"}],
    )
    assert account.account_id == "U1"
    assert str(account.net_liquidation) == "1250.75"
    assert str(account.cash) == "300"
    assert account.buying_power is None
    assert account.maintenance_margin is None

def test_orders_carry_a_stable_positive_identity():
    row = {
        "brokerage_order_id": "abc-123",
        "symbol": {"symbol": {"symbol": "TSLA", "id": "s1"}},
        "action": "BUY",
        "order_type": "Limit",
        "total_quantity": "5",
        "filled_quantity": "2",
        "limit_price": "200",
        "status": "EXECUTED",
    }
    first = snaptrade.normalize_order("U1", row, 0)
    second = snaptrade.normalize_order("U1", row, 0)
    assert first.perm_id == second.perm_id > 0
    assert str(first.remaining_quantity) == "3"

def test_an_activity_without_a_price_or_date_is_skipped():
    assert snaptrade.normalize_activity("U1", {"units": "1"}) is None
    assert snaptrade.normalize_activity("U1", {"units": "1", "price": "5"}) is None
    fill = snaptrade.normalize_activity(
        "U1",
        {
            "id": "act-1",
            "units": "-4",
            "price": "12.5",
            "type": "SELL",
            "trade_date": "2026-09-01T10:00:00Z",
            "symbol": {"symbol": {"symbol": "NVDA", "id": "s2"}},
            "fee": "0.35",
        },
    )
    assert fill is not None
    assert fill.execution_id == "act-1"
    assert str(fill.quantity) == "4", "quantity is reported as a magnitude, with side separate"
    assert str(fill.commission) == "0.35"

def test_secrets_round_trip_and_reject_a_rotated_key(monkeypatch):
    monkeypatch.setattr(settings, "secret_key", "key-one")
    sealed = secrets.encrypt("user-secret")
    assert "user-secret" not in sealed
    assert secrets.decrypt(sealed) == "user-secret"
    monkeypatch.setattr(settings, "secret_key", "key-two")
    with pytest.raises(secrets.SecretUnavailable):
        secrets.decrypt(sealed)

def test_secrets_are_unavailable_without_a_key(monkeypatch):
    monkeypatch.setattr(settings, "secret_key", "")
    assert not secrets.available()
    with pytest.raises(secrets.SecretUnavailable):
        secrets.encrypt("anything")
