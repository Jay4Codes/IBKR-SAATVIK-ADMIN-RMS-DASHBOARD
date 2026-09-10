#!/usr/bin/env bash
# Redeploy the API, web, and worker from the working tree.
#
#   deploy/deploy.sh [/path/to/ibkr-platform]
#
# The backend is an editable install, so Python changes need only a restart.
# Next.js is a standalone bundle, so its static assets have to be copied into
# the bundle after each build — `next build` does not do it, and skipping it
# leaves the app serving 404s for its own CSS and JS.
#
# ibkr-gateway (and any ibkr-gateway@<id> instance) is never restarted here.
# A live gateway restart performs a real IBKR login, and with ReadOnlyLogin=no
# it sends a push to the account holder's phone that expires in 180 seconds.
# Restart one deliberately, from the dashboard or by name.
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"

echo "── Backend checks ───────────────────────────────────────────────"
cd "$ROOT/backend"
.venv/bin/ruff check app tests
.venv/bin/pytest -q

echo "── Frontend build ───────────────────────────────────────────────"
cd "$ROOT/frontend"
npm run lint
npm run typecheck
npm test
npm run build
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public 2>/dev/null || true

echo "── Restart ──────────────────────────────────────────────────────"
systemctl restart ibkr-api ibkr-worker ibkr-web
sleep 3
systemctl is-active ibkr-api ibkr-worker ibkr-web
curl -fsS http://127.0.0.1:8120/health && echo

echo
echo "Deployed. The gateway was not restarted."
