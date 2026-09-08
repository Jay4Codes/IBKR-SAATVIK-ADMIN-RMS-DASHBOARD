from pydantic import BaseModel, Field


class Candle(BaseModel):
    timestamp: int = Field(description="Unix timestamp in seconds")
    open: float
    high: float
    low: float
    close: float
    volume: int


class CandleSeries(BaseModel):
    symbol: str
    source: str
    candles: list[Candle]


class ServiceStatus(BaseModel):
    status: str
    mongodb: str
    redis: str

