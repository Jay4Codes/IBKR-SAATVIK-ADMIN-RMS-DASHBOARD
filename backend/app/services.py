import json
import math
import random
from datetime import UTC, datetime, timedelta
from typing import Any

from pymongo import ASCENDING

from app.models import Candle, CandleSeries


def generate_demo_candles(symbol: str, count: int) -> list[Candle]:
    """Create a stable demo series so the UI works before a data feed is connected."""
    randomizer = random.Random(symbol.upper())
    start = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    start -= timedelta(days=count)
    price = 175.0 + randomizer.uniform(-20, 20)
    candles: list[Candle] = []

    for index in range(count):
        drift = math.sin(index / 8) * 0.8 + randomizer.uniform(-2.2, 2.2)
        open_price = price
        close_price = max(1.0, open_price + drift)
        high = max(open_price, close_price) + randomizer.uniform(0.2, 2.4)
        low = min(open_price, close_price) - randomizer.uniform(0.2, 2.0)
        candles.append(
            Candle(
                timestamp=int((start + timedelta(days=index)).timestamp()),
                open=round(open_price, 2),
                high=round(high, 2),
                low=round(low, 2),
                close=round(close_price, 2),
                volume=randomizer.randint(800_000, 5_500_000),
            )
        )
        price = close_price

    return candles


async def get_candles(app_state: Any, symbol: str, limit: int) -> CandleSeries:
    normalized_symbol = symbol.strip().upper()
    cache_key = f"candles:{normalized_symbol}:{limit}"

    if app_state.redis is not None:
        try:
            cached = await app_state.redis.get(cache_key)
            if cached:
                return CandleSeries.model_validate_json(cached)
        except Exception:
            pass

    series: CandleSeries | None = None
    if app_state.mongodb is not None:
        try:
            cursor = (
                app_state.mongodb.candles.find(
                    {"symbol": normalized_symbol},
                    {
                        "_id": 0,
                        "timestamp": 1,
                        "open": 1,
                        "high": 1,
                        "low": 1,
                        "close": 1,
                        "volume": 1,
                    },
                )
                .sort("timestamp", ASCENDING)
                .limit(limit)
            )
            documents = await cursor.to_list(length=limit)
            if documents:
                series = CandleSeries(
                    symbol=normalized_symbol,
                    source="mongodb",
                    candles=[Candle.model_validate(document) for document in documents],
                )
        except Exception:
            pass

    if series is None:
        series = CandleSeries(
            symbol=normalized_symbol,
            source="demo",
            candles=generate_demo_candles(normalized_symbol, limit),
        )

    if app_state.redis is not None:
        try:
            await app_state.redis.setex(
                cache_key,
                app_state.settings.cache_ttl_seconds,
                json.dumps(series.model_dump()),
            )
        except Exception:
            pass

    return series
