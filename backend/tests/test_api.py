from fastapi.testclient import TestClient

from app.main import app


def test_root() -> None:
    with TestClient(app) as client:
        response = client.get("/")

    assert response.status_code == 200
    assert response.json()["name"] == "Sattvic API"


def test_demo_candles() -> None:
    with TestClient(app) as client:
        response = client.get("/api/v1/market/candles?symbol=AAPL&limit=20")

    assert response.status_code == 200
    payload = response.json()
    assert payload["symbol"] == "AAPL"
    assert len(payload["candles"]) == 20

