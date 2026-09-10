# Phase 1 validation

Two kinds of check appear below. **Executed** checks were run against a real
running stack and their observed output is recorded. **Live-environment** checks
require IB Gateway signed in with the dedicated API username and cannot be
performed without it; they are listed with the exact procedure and pass criteria.

## Environment used for the executed run

Docker is not installed on the validation host, so the stack was run natively with
the same processes Compose starts (`app.main` API, `app.worker`, Next.js), against
locally running MongoDB 27017 and Redis 6379.

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DATABASE=ibkr_validate     # effective database: ibkr_validate_mock
REDIS_URL=redis://127.0.0.1:6379/9 # isolated database, no other application keys
IBKR_MODE=mock
CORS_ORIGINS=http://localhost:3200
```

API on 127.0.0.1:8200, web on 127.0.0.1:3200. `docker compose config` was **not**
executed here for the same reason; `make compose-check` remains outstanding on a
Docker-capable host.

## Static checks

| Check | Command | Result |
| --- | --- | --- |
| Backend tests | `backend/.venv/bin/pytest -q` | 36 passed |
| Backend lint | `ruff check app tests` | All checks passed |
| Frontend tests | `npm test` (vitest) | 10 passed, 2 files |
| Frontend types | `npm run typecheck` | clean |
| Frontend lint | `npm run lint` | clean |
| Frontend build | `npm run build` | compiled; 6 routes emitted |
| Compose config | `make compose-check` | **not run — Docker unavailable** |

Routes emitted: `/`, `/_not-found`, `/accounts/[accountId]`,
`/admin/ibkr-diagnostics`, `/api/[...path]`, `/dashboard`, `/login`.

## Executed runtime checks

### Connection manager

`gateway:primary` and `gateway:primary:lease` present. Structured worker logs show
the documented state machine, including an unforced mock outage and automatic
recovery with no operator action:

```
gateway.state_changed status=CONNECTING  12:02:18.967
gateway.state_changed status=CONNECTED   12:02:18.969
gateway.state_changed status=DISCONNECTED 12:04:09.174
gateway.state_changed status=CONNECTED   12:04:15.185
```

`GET /api/v1/gateway/status` reported `CONNECTED`, advancing `last_heartbeat`,
`reconnect_attempts: 0`, `last_error: null`, and all four subscriptions `ACTIVE`.

### Live state, REST, and precision

All Phase 1 REST routes returned `{"success":true,"data":...}`. Three mock accounts
(`DU100001`–`DU100003`) with full account-value fields. Positions covered STK
(`AAPL`, conId 265598), FUT (`ES`, expiry 20260918, multiplier 50) and OPT (`SPX`),
keyed on `con_id`. Orders exposed `perm_id`, filled/remaining split and IBKR status
values; executions carried `execution_id`, `commission`, `price` and `realized_pnl`.
Every monetary field serialized as a decimal string (`"225.25"`, `"0.35"`), never a
float. Redis held exactly the documented keys: `accounts`, `account:{id}:state`,
`account:{id}:positions`, `account:{id}:orders`, `diagnostics:{id}`, `ibkr.events`,
`ibkr:mode`.

### Durability

MongoDB collections populated: `users`, `roles`, `user_roles`, `account_users`,
`ibkr_gateways`, `ibkr_accounts`, `orders`, `order_events`, `executions`,
`audit_logs`. Executions grew monotonically (18 → 36 across the run) and were never
overwritten; `_id` equals the broker fill ID, making stream replay idempotent.
`order_events` is append-only (342 entries). No account or position ticks were
written to MongoDB — the stream held 1,867 events over the same period while
`orders` stayed at 3 documents.

### WebSocket

Admin socket subscribed with `{"type":"subscribe","accounts":["*"]}`, received a
`subscribed` acknowledgement and a `pong`, then over a 35-second window observed:

| Event | Count |
| --- | --- |
| `gateway.updated` | 17 |
| `account.updated` | 51 |
| `position.updated` | 153 |
| `order.updated` | 51 |
| `execution.created` | 3 |

### Authorization

| Case | Expected | Observed |
| --- | --- | --- |
| ADMIN `GET /accounts` | all accounts | `DU100001, DU100002, DU100003` |
| TRADER `GET /accounts` | assigned only | `DU100001` |
| TRADER `GET /accounts/DU100002/positions` | 403 | 403 `Account access denied` |
| TRADER `GET /admin/diagnostics` | 403 | 403 |
| No session | 401 | 401 |
| Login with foreign `Origin` | 403 | 403 `Untrusted origin` |
| TRADER `POST /admin/diagnostics/visibility` | 403 | 403 |

Account access is resolved from MongoDB per request; the client-supplied account ID
is never trusted on its own.

### Frontend

`/login`, `/dashboard`, `/accounts/DU100001`, `/admin/ibkr-diagnostics` all returned
200; `/` redirected (307) to the authenticated entry point. Login and data fetches
through the Next.js `/api` proxy succeeded and returned all three accounts plus
gateway status. Navigation exposes Overview, Accounts, Positions, Orders, Executions
and Settings. All six KPI cards are implemented (total net liquidation, day P&L,
open positions, open orders, available funds, lowest margin cushion). The account
detail page carries the disabled `Force Exit` control labelled "Available in Risk
Controls phase". The disconnection banner (`LIVE DATA DISCONNECTED`) and the
option display format are implemented in `components/dashboard.tsx` and
`components/tables.tsx`.

The browser origin must match `CORS_ORIGINS` exactly. Reaching the app on
`127.0.0.1` while `CORS_ORIGINS` names `localhost` is rejected with
`Untrusted origin` — expected behaviour, and worth noting during deployment.

### Mock-mode safety

`POST /api/v1/admin/diagnostics/visibility` in mock mode returned
**409 `Visibility evidence requires live mode`**. Mock mode cannot produce a
visibility PASS, so no false cross-username evidence can be recorded.

## Live-environment checks still outstanding

These require IB Gateway and, for the last three, a second IBKR username on the
same account. None can be simulated.

1. **Compose bring-up** — `docker compose up --build -d` on a Docker host; confirm
   `mongodb`, `redis`, `backend`, `ibkr-worker`, `frontend`, `edge` all healthy.
2. **Live connection** — set `IBKR_MODE=live` with a nonzero Master API Client ID
   and Read-Only API enabled; gateway must reach `CONNECTED`.
3. **Live account/position/order/execution data** — values must populate from the
   broker, with unavailable valuations left blank rather than substituted.
4. **Gateway outage** — stop Gateway, observe `DISCONNECTED`/`RECONNECTING` with
   growing `reconnect_attempts`; restart and confirm positions and open orders are
   reconciled from the post-reconnect snapshot.
5. **External order visibility** — start an observation window, place an order
   manually in TWS under the second username, submit its account and `permId`.
   Passes only if that order is in persisted data *and* an order event appears
   inside the window.
6. **External execution visibility** — fill that order manually and submit the
   execution ID. Requires the exact fill, a position quantity change for the fill's
   conId, and a filled-quantity order-status event for the same permId.
7. **Working-order visibility** — submit the full set of currently working permIds
   from TWS while they are still working; missing IDs are reported explicitly.

A PASS covers only the identifiers supplied and the session and configuration
tested. It is not a claim that every possible username or order is visible, and it
is not by itself approval to build the kill switch.

## Phase 1 scope boundary

No risk engine, kill switch, force exit, order placement, order binding, or
cancellation exists in this codebase. The worker connects with
`readonly=True` and client ID 0 is rejected so that manual orders are never bound.

## Multi-tenancy — 2026-09-09

Executed on the deployment host, against the running installation.

| Check | Result |
| --- | --- |
| `backend/.venv/bin/pytest -q` | 197 passed |
| `backend/.venv/bin/ruff check app tests` | clean |
| `frontend: npm run lint` | clean |
| `frontend: npm run typecheck` | clean |
| `frontend: npm test` | 64 passed |
| `frontend: npm run build` | compiled |
| `make compose-check` | compose file parses (Docker is not installed here) |

Isolation is asserted, not assumed. The API test suite seeds a second tenant
with its own gateway and accounts, so every cross-tenant assertion has something
real to leak from: `tests/test_auth_api.py` proves the other tenant's account is
a 404 rather than a 403, that naming a tenant you are not a member of is
refused, and that a super admin acting inside one is flagged as impersonating;
`tests/test_state.py` proves two tenants holding the same account identifier keep
two separate rows and two separate streams; `tests/test_websocket.py` proves a
socket reads only the stream its handshake resolved, with a backlog sitting on
the other tenant's stream to make a leak visible; `tests/test_gateway_commands.py`
proves the command rate limit is per connection, so one tenant's burst cannot
throttle another's gateway.

`tests/test_provisioning.py` renders a gateway instance against a throwaway IBC
installation and asserts the config is 0600, the template's credentials are not
inherited, the launcher points at that instance's own files, re-provisioning
preserves a password already on disk, and an adopted instance is never deleted.

### Live migration

`python -m app.migrate --dry-run` then `python -m app.migrate` were run against
`ibkr_rms_live` after a `mongodump`. The first attempt **failed**, which is why
`tests/test_migrate.py` now covers it: the pre-tenancy account document keeps the
account number in `_id` and has no `account_id` field at all, so every such
document collided as `(null, null)` on the new unique `(tenant_id, account_id)`
index. Index creation now runs after the backfill, and `initialize()` reports the
actionable cause instead of a raw duplicate-key error.

After migrating and restarting `ibkr-api ibkr-worker ibkr-web`, the adopted
gateway reconnected on its own — `gateway.state_changed status=CONNECTED` — and
`GET /api/v1/accounts` returned the real account. `ibkr-gateway` was not
restarted at any point; its uptime spans the whole exercise.

The dashboard was also rendered headlessly against a throwaway database on a
spare port (dropped afterwards) to check the reworked layout at 1440px and
420px, in both themes. That found two real defects, both fixed: the read-only
login checkbox inherited the uppercase field-label treatment and rendered as a
floating tick above a shouted paragraph, and the administration screens still
carried a reporting-currency selector and a "MONITOR" eyebrow.

### Not covered

* SnapTrade against the live API. The adapter, its request signing, and its
  normalisation are unit-tested, but no partner credentials are configured on
  this host, so no real call has been made.
* Provisioning a second gateway end to end. The files and unit are rendered and
  asserted in tests; no second IBKR login exists here to start one with.
* Two tenants streaming live broker data at once.
