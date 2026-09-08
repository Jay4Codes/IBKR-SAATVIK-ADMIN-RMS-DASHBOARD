# Sattvic Trading Dashboard

A full-stack starter for a market dashboard:

- Next.js App Router, React, and TypeScript
- Tailwind CSS and shadcn/ui-style components
- TradingView Lightweight Charts and Apache ECharts
- FastAPI with async MongoDB and Redis clients
- Docker Compose for a reproducible local stack

## Quick start with Docker

```bash
cp .env.example .env
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). API docs are at
[http://localhost:8000/docs](http://localhost:8000/docs).

By default Compose starts local MongoDB and Redis containers. To use MongoDB
Atlas, put your connection string in the root `.env`:

```dotenv
MONGODB_URI=mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/?retryWrites=true&w=majority
MONGODB_DATABASE=sattvic
```

The `.env` file is ignored by Git.

## Run without Docker

Start MongoDB and Redis, then install dependencies:

```bash
make install
cp backend/.env.example backend/.env
```

Run the API and frontend in separate terminals:

```bash
cd backend && .venv/bin/uvicorn app.main:app --reload
cd frontend && npm run dev
```

The frontend proxies `/api/*` to `http://localhost:8000` by default. Set
`API_INTERNAL_URL` if the API runs elsewhere.

## Checks

```bash
make test
make lint
```

The market endpoint uses deterministic demo candles when MongoDB has no data.
Store candle documents in the `candles` collection with `symbol`, `timestamp`,
`open`, `high`, `low`, `close`, and `volume` fields to display real data.

