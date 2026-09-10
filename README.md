# IBKR Admin RMS

Read-only Interactive Brokers connectivity, account monitoring, and durable
order/fill history. The application lives in [`ibkr-platform/`](ibkr-platform/);
see its [README](ibkr-platform/README.md) for setup, the IB Gateway connection,
and two-factor login handling.

## Layout

| Path | What it is |
| --- | --- |
| `ibkr-platform/` | The application: FastAPI backend, Next.js frontend, IBKR worker. |
| `external/US-Trading-Infra/` | A separate trading system, vendored read-only as a reference. Not deployed. |

## Deployment on this host

Runs under systemd, not Docker (the compose file in `ibkr-platform/` describes a
different deployment shape).

| Unit | Bind | Runs |
| --- | --- | --- |
| `ibkr-api` | 127.0.0.1:8120 | `uvicorn app.main:app --workers 2` |
| `ibkr-web` | 127.0.0.1:3020 | Next.js standalone build |
| `ibkr-worker` | outbound only | `python -m app.worker` — the only process speaking the TWS API |
| `ibkr-gateway` | 127.0.0.1:4001 | IB Gateway under IBC inside Xvfb |

nginx terminates TLS at `sattvic-rms.ekalonsolutions.com` and routes `/` to the
web service, `/api/v1/` and `/ws/live` to the API. The former hostname
`saatvik-rms.ekalonsolutions.com` keeps its own certificate and 301-redirects
every request to the new one.

To deploy: rebuild the frontend, copy static assets into the standalone bundle,
then restart the services.

```bash
cd ibkr-platform/frontend && npm run build
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
systemctl restart ibkr-api ibkr-web ibkr-worker
```

The backend is an editable install, so Python changes need only a restart.

## Retired

A "Sattvic Trading Dashboard" market-data starter previously served this domain
from ports 8110/3010. It was superseded by `ibkr-platform` on 2026-09-08 and
removed from this repository on 2026-09-09; its services are stopped and their
unit files deleted. The code remains in git history, and a working-tree archive
including its uncommitted changes is at `/root/sattvic-dashboard-retired-*.tar.gz`.
