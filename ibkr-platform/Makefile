.PHONY: test lint typecheck compose-check

test:
	cd backend && .venv/bin/pytest -q
	cd frontend && npm test
lint:
	cd backend && .venv/bin/ruff check app tests
	cd frontend && npm run lint
typecheck:
	cd frontend && npm run typecheck
compose-check:
	@command -v docker >/dev/null 2>&1 \
		&& docker compose --env-file .env.example config --quiet \
		|| python3 -c "import yaml,sys; d=yaml.safe_load(open('docker-compose.yml')); \
sys.exit(0 if {'backend','ibkr-worker','frontend','edge'} <= set(d['services']) else 'compose services missing')" \
		&& echo "compose file parsed (docker not installed; skipped full validation)"

# Report what moving a pre-tenancy installation onto the tenant model would change.
migrate-dry:
	cd backend && .venv/bin/python -m app.migrate --dry-run

migrate:
	cd backend && .venv/bin/python -m app.migrate
