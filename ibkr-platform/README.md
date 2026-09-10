# IBKR Admin RMS

Multi-tenant, read-only IBKR connectivity: account monitoring, durable order and
fill history, and visibility diagnostics. Sattvic is one tenant; each client is
another, with its own members, its own broker connection, and no sight of anyone
else's data.

MongoDB holds identity, tenancy, and durable history. Redis holds live state and
the per-tenant event stream. The dashboard includes account and desk payoff
scenarios for stocks and standard stock options. There is no automated risk
enforcement, kill switch, order placement, order binding, or cancellation.

* [docs/multi-tenancy.md](docs/multi-tenancy.md) — the isolation model, roles,
  and broker connections.
* [docs/migration-runbook.md](docs/migration-runbook.md) — moving a running
  single-gateway install onto it, and onboarding the next client.
* [deploy/README.md](deploy/README.md) — the per-connection gateway instances.
* [docs/payoff-risk.md](docs/payoff-risk.md) — payoff curves, scenario assumptions,
  and coverage limits.

## Deploy

This platform runs under **systemd**. Units are versioned in `deploy/`, and the
deployment path is `deploy/install-units.sh` followed by `deploy/deploy.sh`.

```bash
cd ibkr-platform
cp .env.example .env            # then edit; SECRET_KEY has no default
sudo deploy/install-units.sh    # ibkr-api, ibkr-web, ibkr-worker, ibkr-gateway@
systemctl enable --now ibkr-api ibkr-web ibkr-worker
backend/.venv/bin/python -m app.auth ekalon.consulting@gmail.com --tenant saatvik --super-admin
```

Prerequisites: Python 3.12+ (tested with 3.13), Node 22, and MongoDB and Redis
reachable from this host. Build the backend virtualenv and the frontend bundle
once before the first start:

```bash
cd backend && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
cd ../frontend && npm ci && npm run build && cp -r .next/static .next/standalone/.next/static
```

`ibkr-api` listens on `127.0.0.1:8120` and `ibkr-web` on `127.0.0.1:3020`;
terminate TLS and route both at your existing reverse proxy, and set
`CORS_ORIGINS` to the exact browser origin with `COOKIE_SECURE=true`. The API
and the WebSocket must reach the browser on the same origin as the pages, or the
session cookie will not accompany the WebSocket handshake.

**Redeploying** is `deploy/deploy.sh`: it lints, tests, builds, copies the Next
static assets into the standalone bundle, and restarts `ibkr-api`,
`ibkr-worker`, and `ibkr-web`. It never restarts a gateway — a live gateway
restart performs a real IBKR login.

`python -m app.auth` prompts for a password of at least 12 characters. No
application password or IBKR credential is shipped. Only
`ekalon.consulting@gmail.com` receives platform administration and access to every
tenant. All other logins are limited to Monitor; stored admin flags and tenant
roles cannot grant administration. The CLI rejects `--super-admin` for any other
email. Use `--tenant <slug> --role TRADER --accounts DU1 DU2` for a client's desk
user.

A `docker-compose.yml` is kept for local development on a throwaway machine. It
is not the deployment path, and gateway provisioning is disabled under it —
writing IBC configs and systemd units is a host operation a container cannot do.

## Tenancy in one paragraph

One database, shared collections, and a `tenant_id` on every tenant-owned
document, with compound indexes leading with it. Redis keys are namespaced
`t:<tenant id>:…` and are built from the resolved tenant rather than passed in,
so a repository handed to one tenant cannot address another's. Identity is
platform-wide — one login can hold memberships in several tenants — while
authorization is per tenant and re-resolved from MongoDB on every request and
every WebSocket event batch, so revoking access takes effect immediately.
Broker account numbers, `permId`s, and execution ids are unique within a broker
but not across tenants, so durable documents are keyed `<tenant id>:<broker id>`.

The active tenant comes from the `X-Tenant` header, else the readable
`ibkr_tenant` cookie, else the login's default. All three are preferences, not
credentials: naming a tenant you are not a member of earns a 403.

## Broker connections

A connection is one tenant's link to one broker session, and its document is the
source of truth for where that session connects and which systemd unit and IBC
config belong to it.

**IB Gateway.** Adding one allocates a free API port and a nonzero client id,
writes that instance's own IBC config and launcher under
`GATEWAY_INSTANCE_ROOT/<connection id>/`, and installs the templated
`ibkr-gateway@.service`. The IBKR password is supplied separately and is written
only to that config file, at 0600 — never to MongoDB, never to an API response,
never to a log. A gateway adopted from a pre-tenancy install keeps its own path
and unit and is never rewritten or deleted.

**SnapTrade.** No gateway at all: the client authorises their brokerage on
SnapTrade's hosted screens through a single-use link, and no IBKR password
reaches this platform. It is polled rather than streamed, and emits the same
domain events a gateway session does. It stays unavailable until
`SNAPTRADE_CLIENT_ID` and `SNAPTRADE_CONSUMER_KEY` are set; the user secret it
issues is encrypted under `SECRET_KEY` before storage and is never returned.

The worker is a supervisor: it re-reads the connection registry every ten
seconds and holds one session per enabled connection in an active tenant, plus
one durable MongoDB consumer per tenant. Each session takes a Redis lease on its
own connection key, so two worker processes are safe and a session that loses
its lease stops touching the broker rather than racing.

## Connect a tenant to IBKR

Either provision a gateway for them, or send them a SnapTrade link. Both are
done from **Connections** inside the tenant, as an `OWNER` or `ADMIN`.

### Provisioning an IB Gateway

1. **Connections → Add connection → IB Gateway.** Name it, pick paper or live,
   and optionally restrict it to a single account. A free API port from
   `GATEWAY_PORT_RANGE_START..END` and a nonzero client id are allocated for
   you, and the instance's IBC config, launcher, settings directory, and log
   directory are created under `GATEWAY_INSTANCE_ROOT/<connection id>/`.

   Client id 0 is refused everywhere in this platform: `ib_async` automatically
   binds manual orders for that client, and nothing here may bind a broker
   order.

2. **Add the IBKR login.** On the connection, open **IBKR login** and supply the
   client's dedicated API username and password. It is written only to that
   instance's `config.ini`, at 0600. It is never stored in MongoDB, never
   returned by the API, and never logged.

   Leave **read-only login** on unless the tenant needs order placement one day.
   A read-only login skips IBKR's second factor entirely, which is what lets the
   gateway start unattended; turning it off means every start waits on a push
   notification approved in IBKR Mobile.

   If the IBKR account has more than one second-factor device enrolled, set the
   device name (for example `IB Key`) when creating the connection. With it
   unset, IBC cannot choose and no push is ever sent — the dashboard reports
   this as `two_factor_device_required` rather than leaving you watching a
   prompt that will not arrive.

3. **Enable the connection, then start the gateway.** Enabling tells the worker
   to hold a session for it; it picks it up within ten seconds. Starting the
   gateway performs a real IBKR login.

4. **Verify.** The gateway panel should reach *Online*, and accounts, positions,
   orders, and executions should populate. Missing valuations stay blank; the
   adapter never substitutes placeholder values. Open
   `/admin/ibkr-diagnostics` for subscription health and the event log.

On the gateway host, IBC must be installed with its `gatewaystart.sh` beside the
config named by `GATEWAY_TEMPLATE_CONFIG`, and IB Gateway installed at
`${TWS_PATH}/ibgateway/<version>/` — IBC requires that exact versioned layout.
See [deploy/README.md](deploy/README.md).

### Connecting through SnapTrade

With `SNAPTRADE_CLIENT_ID` and `SNAPTRADE_CONSUMER_KEY` configured, **Add
connection → SnapTrade** registers a SnapTrade user for the connection and
**Get connection link** issues a single-use hosted-consent URL. Send it to the
client; they authorise their brokerage on IBKR's and SnapTrade's own screens,
and no IBKR password reaches this platform or its operator. **Check
authorisations** confirms the link completed. Enable the connection and the
worker begins polling it every `SNAPTRADE_POLL_SECONDS`.

SnapTrade reports less than IBKR's account summary: margin figures and buying
power are frequently absent, and stay blank rather than being invented.

### What the gateway session does

The worker uses `ib_async.connectAsync(readonly=True)` with a timeout, account
summary and multi-account subscriptions, position subscriptions, account and
position PnL subscriptions, all-open-order snapshots, execution snapshots, and
callback updates. It refreshes all visible open orders and recent executions
every heartbeat (default 10 seconds), since `reqAllOpenOrders` is a snapshot
rather than a guarantee of future updates from every other client. Master Client
configuration is necessary for broader callback visibility; cross-username
visibility must still be tested per connection.

Each session holds a renewable Redis lease on its own connection key. Lease loss
or a Redis publication failure stops that broker session and no other. Heartbeats
use a broker server request, reconnect backoff grows exponentially with jitter to
approximately 60s, and subscriptions and snapshots are recreated after reconnect.
Successful snapshots reconcile positions and active orders missed during an
outage. Ten consecutive failures display FAILED while retries continue. A stale
worker heartbeat displays DEGRADED even if the last published state was
CONNECTED.

## Two-factor login

IBKR's second factor is a push notification a human approves in IBKR Mobile. No
part of this platform can answer it, and nothing here stores or replays a second
factor. What it does is make the wait visible and keep operators from breaking it.

The backend reads each connection's own IBC logs and reports a `login_phase` on
`GET /api/v1/gateway` and on every row of `GET /api/v1/connections`. One poller
covers every managed gateway across every tenant, holding a short per-connection
lock so two API workers never poll the same one twice:

| Phase | Meaning |
| --- | --- |
| `logged_in` | The API port is open. Proof of a finished login; logs cannot contradict it. |
| `starting` | The process is up but has not reached the login yet. |
| `connecting` | Talking to IBKR, no push seen yet. |
| `connecting_stale` | Still connecting past `GATEWAY_CONNECT_STALE_SECONDS` (default 90). Restart it. |
| `two_factor` | A push is outstanding. `two_factor_remaining_seconds` counts down. |
| `two_factor_expired` | The push ran out. Restart, then approve promptly. |
| `auth_failed` | IBKR rejected the credentials. |
| `down` | The process is not running, or it exited. |

The deadline comes from IBC's own `SecondFactorAuthenticationTimeout`, read live
out of that connection's own IBC config, falling back to
`TWO_FACTOR_TIMEOUT_SECONDS` (180) when the file is unreadable. `two_factor_started_at` is emitted with a UTC offset, so
the dashboard counts down against the same instant regardless of browser timezone.
These fields are ADMIN-only; the trader view is unchanged.

A poller (`GATEWAY_LOGIN_POLL_SECONDS`, default 5) refreshes this and pushes a
`gateway.updated` event on each phase change, so the banner appears without
waiting for the 15s REST refresh. It stores its result under its own Redis key with
a short expiry, and never writes the connection state the worker owns.

**The restart guard.** `POST /api/v1/connections/{id}/process` refuses `stop` and
`restart` with **409** while a push is outstanding and more than
`TWO_FACTOR_GRACE_SECONDS` (default 30) remain — restarting then cancels a
request the operator may be seconds from approving. The refusal happens before
the command rate limit is consumed, so the deliberate retry is not thrown a 429.
To override, resend with `{"force": true}`; the dashboard asks first, and the
audit record keeps the flag. `start` is never blocked, and an already-expired
push never blocks the restart that recovers from it.

Recommended IBC settings for an unattended host:

```ini
SecondFactorAuthenticationTimeout=180
ReloginAfterSecondFactorAuthenticationTimeout=yes
ExitAfterSecondFactorAuthenticationTimeout=no
ExistingSessionDetectedAction=primary
```

With relogin enabled, IBC sends a fresh push after a timeout. The dashboard
tracks the newest push rather than pinning itself to the first one that expired,
and reports `two_factor_attempts` so a login loop is visible instead of looking
like one very patient prompt.

Set `IBC_LOG_DIRECTORY` to wherever the `ibc-*_GATEWAY-*.txt` files land, and
make sure the backend can read it. With no readable logs the phase degrades to
`starting` or `down` and the rest of the dashboard is unaffected.

IBKR may only supply recent/session executions through this API; the application
retains every fill it receives but cannot reconstruct fills the broker never exposes.
Start monitoring before the activity you need to capture. PnL reset behavior and
market-data availability follow the account's IBKR configuration and permissions.
Cross-currency position valuations remain blank when their currency cannot be
established safely. Dashboard monetary totals are grouped by account base currency;
there is no implicit FX conversion. Derivative average cost is the broker-reported
contract cost, including the multiplier, and differs in units from the quote mark.

IBKR references:
[ib_async API](https://ib-api-reloaded.github.io/ib_async/api.html),
[open-order visibility](https://interactivebrokers.github.io/tws-api/open_orders.html),
[Master Client configuration](https://interactivebrokers.github.io/tws-api/initial_setup.html).

## Gateway controls (ADMIN)

The dashboard's gateway panel carries two ADMIN-only controls. Both are connection
management, never broker mutations: no order is placed, modified, bound, or cancelled.

**Reconnect now** drops the current broker session and reconnects immediately. It
also clears the backoff and the failure counter, so a gateway stuck in `FAILED`
retries at once instead of waiting out its delay. Use it after restarting IB Gateway.

**Connection settings** overrides host, port, and client ID at runtime and then
reconnects. The override is stored at `t:{tenant}:c:{connection}:target` and takes
precedence over the connection's own host, port, and client id; the panel always
displays the target actually in use. Delete that key and reconnect to return to
the connection's configured values. Client ID 0 is rejected here as it is everywhere
else.

Both are tenant-administrator only, rejected for TRADER with 403, rate limited to
one command per five seconds **per connection** (429 otherwise) so one tenant's
burst never throttles another's gateway, and written to `audit_logs` with the
acting user, the tenant, and the connection. The API publishes to the
`platform.commands` Redis channel; the worker is the only component that touches
a broker session. A command naming a connection whose session belongs to another
tenant is dropped, and unsupported commands are logged and ignored.

## Verify another IBKR username's activity

Use a paper account first. This is an observation workflow: the dashboard has no
trading controls and cannot create the external activity itself.

1. Log into TWS with the second username on the same account.
2. In `/admin/ibkr-diagnostics`, confirm CONNECTED and active account,
   position, order, and execution subscriptions. Click **Begin observation window**.
3. Manually create an order in TWS. Enter the account and its permanent broker
   order ID (`permId`), then click **Check visibility**. Order Visibility passes only
   when that account/permId appears in persisted order data and an event in this window.
4. Execute the order manually in TWS. Enter its execution ID and check again.
   Execution Visibility requires the exact fill, a position **quantity change** for
   the fill's conId, and a filled-quantity order-status event for the same permId.
   An unrelated position/PnL event or a historical replay is insufficient.
5. Copy the complete set of currently working permanent order IDs from TWS into
   the comma-separated field. Check while they are still working. Missing IDs are
   listed explicitly. Blank expectations remain NOT_TESTED.
6. Stop/restart Gateway and confirm disconnection, reconnect attempts, fresh
   heartbeats, and reconciled open positions/orders after recovery.

Checks must be within a one-hour observation window and below 10,000 stream events;
start a shorter window for a busy account. Results and their evidence are audited
in MongoDB. FAIL means the expected evidence was not observed at the time of the
check; allow for broker/stream latency and repeat if necessary. A PASS covers only
the supplied identifiers and the tested session/configuration. The operator must
confirm that the order really originated from the second username. It is **not** a
claim that every possible username/order is visible and is not approval to build a
kill switch. A visibility check requires a healthy live Gateway connection, and is
evaluated against the active tenant's own event stream and durable records only.

## Local development

Use Python 3.12+ (tested with 3.13) and Node 22. Start MongoDB and Redis separately.
In `backend/.env`, configure local URLs and your browser origin:

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DATABASE=ibkr_rms_dev
REDIS_URL=redis://127.0.0.1:6379/0
CORS_ORIGINS=http://localhost:3000
COOKIE_SECURE=false
SECRET_KEY=any-non-empty-string-for-development
GATEWAY_PROVISIONING_ENABLED=false
```

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/python -m app.auth ekalon.consulting@gmail.com --tenant saatvik --super-admin
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
# In a second terminal, also from backend:
.venv/bin/python -m app.worker
```

```bash
cd frontend
npm ci
NEXT_PUBLIC_WS_URL=ws://localhost:8000/ws/live npm run dev
```

The Next.js `/api` proxy forwards REST calls and session cookies to
`API_INTERNAL_URL` (default `http://localhost:8000`). The browser must use the same
hostname for API and frontend so its cookie accompanies the WebSocket handshake.
`NEXT_PUBLIC_WS_URL` is a build-time variable for production builds. Under the
systemd deployment it is left unset and `/ws/live` is routed to the API by the
same reverse proxy that serves the pages, so the socket is same-origin and the
session cookie accompanies its handshake.

Every screen renders only what the broker reports. There is no simulated data source:
a running IB Gateway is required for the dashboard to show accounts, positions,
orders, or executions.

## API and data contracts

All REST responses use `{"success":true,"data":...}`; errors use
`{"success":false,"error":"..."}` with 401/403/404/409/422/429/503 as appropriate.
All API data routes except health require a session, and every one of them acts
inside the caller's active tenant. `X-Tenant` names it per request.

| Route | Purpose |
| --- | --- |
| `GET /health` | MongoDB and Redis readiness |
| `POST /api/v1/auth/login`, `/logout` | Session lifecycle |
| `GET /api/v1/auth/me` | Current user, active tenant, and memberships |
| `GET /api/v1/tenants` | Tenants this login may act inside |
| `POST /api/v1/tenants/switch` | Change the active tenant for this browser |
| `GET`/`POST /api/v1/admin/tenants` | SUPER_ADMIN: list and create tenants |
| `POST /api/v1/admin/tenants/{id}` | SUPER_ADMIN: rename, suspend, reactivate |
| `GET`/`POST /api/v1/members` | Tenant admin: list and grant access |
| `DELETE /api/v1/members/{user_id}` | Tenant admin: archive a membership |
| `GET`/`POST /api/v1/connections` | Tenant admin: list and provision connections |
| `POST`/`DELETE /api/v1/connections/{id}` | Tenant admin: update or remove one |
| `POST /api/v1/connections/{id}/credentials` | Write an IBKR login to its IBC config |
| `POST /api/v1/connections/{id}/process` | Start, stop, or restart its gateway |
| `POST /api/v1/connections/{id}/target` | Override host/port/client ID, then reconnect |
| `POST /api/v1/connections/{id}/reconnect` | Force an immediate reconnect |
| `POST /api/v1/connections/{id}/snaptrade/link` | Issue a single-use consent link |
| `GET /api/v1/connections/{id}/snaptrade/status` | Which brokerages the client linked |
| `GET /api/v1/gateway`, `/gateway/status` | The tenant's primary connection, with stale detection |
| `POST /api/v1/gateway/{reconnect,target,process,credentials}` | The same, aimed at the primary connection |
| `GET /api/v1/accounts` | Authorized account summaries |
| `GET /api/v1/accounts/{id}`, `/{id}/summary` | Account values and counts |
| `GET /api/v1/accounts/{id}/positions` | Current positions |
| `GET /api/v1/accounts/{id}/orders` | Current active orders |
| `GET /api/v1/accounts/{id}/executions?limit=100` | Durable fills; limit capped at 500 |
| `GET /api/v1/admin/diagnostics` | Subscriptions, last events, event log, visibility results |
| `POST /api/v1/admin/diagnostics/visibility` | Evaluate and audit supplied visibility evidence |
| `WS /ws/live` | The active tenant's live events |

WebSocket clients send `{"type":"subscribe","accounts":["DU123456"]}`; a tenant
administrator may subscribe to `["*"]`. The socket reads only the stream of the
tenant its handshake resolved; re-resolving identity on each batch can revoke
access, never widen it to another tenant. Send `{"type":"ping"}` at least every 30 seconds. The server
acknowledges subscriptions, responds with `pong`, and closes idle sockets after 45s.
The frontend reconnects with backoff and refetches snapshots after subscription
acknowledgement to recover gaps. Updates modify TanStack Query rows, with brief
cell highlights and a persistent disconnection banner. Slow/disconnected clients
are cleaned up. Gateway events map to `gateway.updated`; position closures, order
terminal events, and reconciliation events also travel over this channel.

`shared/domain.schema.json` contains the serialized domain schemas. Financial
values are Decimal in Python and decimal strings in JSON/MongoDB. Frontend sums
use decimal.js; floating-point conversion is confined to visual chart geometry.
Every event contains `event_id`, `event_type`, `account_id`, UTC `timestamp`, and
normalized `data`. Gateway/global reconciliation events use `account_id: "*"`.
`con_id` is instrument identity. Positive `perm_id` is order identity; orders
without a permanent ID temporarily use account/client/order ID.

Redis keys are namespaced per tenant: `t:{tenant}:events`, `t:{tenant}:accounts`,
`t:{tenant}:account:{id}:state|positions|orders`, `t:{tenant}:diagnostics:{id}`,
and per connection `t:{tenant}:c:{connection}:gateway|lease|target|login|accounts`.
Session and login-throttle keys are platform-wide and hashed. Operator commands
travel on one `platform.commands` channel whose payload names the tenant and
connection; the supervisor routes each to the session that owns it and drops any
whose tenant does not match.
State writes and stream appends are transactional. Redis AOF uses `appendfsync
always` and no eviction. Broker callbacks enter a bounded queue; queue
failure is logged and forces resynchronization. There is still an unavoidable
crash window before a received broker callback reaches Redis; broker snapshots
recover what remains available from IBKR.

MongoDB collections. Platform scope: `users`, `roles`, `user_roles`, `tenants`.
Tenant scope, every document carrying a `tenant_id` and every index leading with
it: `tenant_members`, `account_users`, `broker_connections`, `ibkr_accounts`,
`orders`, `order_events`, `executions`, `audit_logs`, `visibility_tests`. Broker
identifiers are unique within a broker but not across tenants, so `orders` and
`executions` are keyed `<tenant id>:<broker id>`. Account/position ticks are not persisted in MongoDB. The worker
consumes each tenant's stream in order using a consumer group and acknowledges only after
successful MongoDB writes. On database failure it retries pending entries. Unique
fill IDs make replay idempotent; late commission reports enrich only commission
and realized PnL, never immutable execution fields. Order snapshots and append-only
order events preserve lifecycle history.

The stream is intentionally not automatically trimmed in Phase 1: trimming pending
events could lose durable records. Monitor Redis disk/memory and stream length;
any future retention policy must archive and trim only events already acknowledged
by durable consumers. Back up MongoDB and the Redis AOF volume. There is no guarantee
of broker events while IBKR itself is unavailable or not entitled to expose them.

## Validation

```bash
make test
make lint
make typecheck
make compose-check
cd frontend && npm run build
```

See [docs/validation.md](docs/validation.md) for actual executed checks and the
remaining live-environment acceptance tests. No Phase 2 controls have been added.
