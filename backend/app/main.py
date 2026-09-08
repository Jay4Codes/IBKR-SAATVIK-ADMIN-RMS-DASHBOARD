from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from types import SimpleNamespace

from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pymongo import AsyncMongoClient
from redis.asyncio import Redis

from app.config import get_settings
from app.models import CandleSeries, ServiceStatus
from app.services import get_candles

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    mongo_client = None
    mongodb = None
    redis_client = None

    if settings.mongodb_uri:
        mongo_client = AsyncMongoClient(settings.mongodb_uri, serverSelectionTimeoutMS=2_000)
        mongodb = mongo_client[settings.mongodb_database]

    if settings.redis_url:
        redis_client = Redis.from_url(settings.redis_url, decode_responses=True)

    app.state.services = SimpleNamespace(
        mongo_client=mongo_client,
        mongodb=mongodb,
        redis=redis_client,
        settings=settings,
    )
    yield

    if redis_client is not None:
        await redis_client.aclose()
    if mongo_client is not None:
        await mongo_client.close()


app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    description="Market data API with MongoDB persistence and Redis caching.",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root() -> dict[str, str]:
    return {"name": settings.app_name, "docs": "/docs"}


@app.get("/health", response_model=ServiceStatus)
async def health(request: Request) -> ServiceStatus:
    services = request.app.state.services
    mongo_status = "not configured"
    redis_status = "not configured"

    if services.mongo_client is not None:
        try:
            await services.mongo_client.admin.command("ping")
            mongo_status = "connected"
        except Exception:
            mongo_status = "unavailable"

    if services.redis is not None:
        try:
            await services.redis.ping()
            redis_status = "connected"
        except Exception:
            redis_status = "unavailable"

    is_healthy = all(status != "unavailable" for status in (mongo_status, redis_status))
    return ServiceStatus(
        status="ok" if is_healthy else "degraded",
        mongodb=mongo_status,
        redis=redis_status,
    )


@app.get("/api/v1/market/candles", response_model=CandleSeries)
async def market_candles(
    request: Request,
    symbol: str = Query(default="AAPL", min_length=1, max_length=12, pattern=r"^[A-Za-z0-9.\-]+$"),
    limit: int = Query(default=90, ge=20, le=500),
) -> CandleSeries:
    return await get_candles(request.app.state.services, symbol, limit)

