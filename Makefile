.PHONY: install dev services down test lint

install:
	cd frontend && npm install
	cd backend && python3 -m venv .venv && .venv/bin/python -m pip install -e ".[dev]"

services:
	docker compose up -d mongodb redis

dev:
	docker compose up --build

down:
	docker compose down

test:
	cd backend && .venv/bin/pytest
	cd frontend && npm run typecheck

lint:
	cd backend && .venv/bin/ruff check .
	cd frontend && npm run lint

