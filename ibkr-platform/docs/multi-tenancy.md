# Multi-tenancy

Sattvic is one tenant. Adding a client means adding another — a tenant, its
members, and its own broker connection — without touching anyone else's data,
gateway, or credentials.

## Isolation model

One MongoDB database, shared collections, and a `tenant_id` discriminator on
every tenant-owned document. This is the model the Carat-Flow platform uses, and
it is chosen for the same reasons: index and connection-pool cost stays flat as
tenants are added, cross-tenant platform administration is a single query, and
onboarding is an insert rather than a provisioning job.

Its known weakness is that isolation depends on every query being scoped, so the
scoping is not left to discipline:

* **Indexes lead with `tenant_id`.** A scoped query is also the fast query, and
  a query that forgot its scope cannot ride an index.
* **`Principal.scope()` builds the filter.** Route handlers ask the resolved
  caller for a filter rather than assembling one, so a handler cannot name a
  tenant it was not resolved against.
* **Redis keys are built, not passed.** `TenantKeys` is constructed from the
  resolved tenant id and hands out complete keys (`t:<tenant>:events`,
  `t:<tenant>:account:<id>:orders`). A repository handed to one tenant's request
  or worker session cannot address another tenant's namespace.
* **Broker identifiers are re-keyed.** Account numbers, `permId`s and execution
  ids are unique within a broker, not across tenants, so durable documents are
  stored under `<tenant id>:<broker id>`. Two tenants can hold the same fill id.

| Collection | Scope |
| --- | --- |
| `users`, `roles`, `user_roles` | Platform. One login, many tenants. |
| `tenants` | Platform. Slug, name, status, feature flags. |
| `tenant_members` | Tenant. Role, and account grants for scoped roles. |
| `broker_connections` | Tenant. One document per broker session. |
| `ibkr_accounts`, `orders`, `order_events`, `executions` | Tenant. |
| `audit_logs`, `visibility_tests` | Tenant. |

## Identity and roles

Identity is platform-wide; authorization is per tenant and is re-resolved from
MongoDB on **every** request and every WebSocket event batch, so revoking a
membership takes effect immediately — including on an already-open socket.

| Role | Sees | Can |
| --- | --- | --- |
| `OWNER` | Every account in the tenant | Everything below, plus members |
| `ADMIN` | Every account in the tenant | Broker connections, diagnostics |
| `TRADER` | Only granted accounts | Read |
| `VIEWER` | Only granted accounts | Read |

A platform `SUPER_ADMIN` is a separate axis: it may act inside any tenant, and
the dashboard says so with an **ADMIN VIEW** marker while it does. Every action
it takes is audited with `impersonated: true`.

The active tenant comes from the `X-Tenant` header, else the readable
`ibkr_tenant` cookie, else the login's default. All three are *preferences*: the
API holds the caller to their memberships regardless of what they name, so
pointing the cookie at another tenant earns a 403, not access.

## Broker connections

A connection is one tenant's link to one broker session. The document is the
source of truth for where that session connects and which unit and config file
belong to it — nothing reads a global gateway setting any more.

**`ibkr_gateway`** runs a dedicated IB Gateway on this host. Creating one
allocates a free API port and a nonzero client id, writes that instance's own
IBC config and launcher under `GATEWAY_INSTANCE_ROOT/<connection id>/`, and
installs the templated `ibkr-gateway@.service`. See [deploy/README.md](../deploy/README.md).

**`snaptrade`** needs no gateway. The client authorises their brokerage on
SnapTrade's hosted screens and no IBKR password ever reaches this platform. It
is a polling source, refreshed on `SNAPTRADE_POLL_SECONDS`, and emits the same
domain events a gateway session does. It stays unavailable until
`SNAPTRADE_CLIENT_ID` and `SNAPTRADE_CONSUMER_KEY` are configured; the user
secret it issues is encrypted under `SECRET_KEY` before storage and is never
returned by the API.

The **worker is a supervisor**. It re-reads the connection registry every ten
seconds and holds one session per enabled connection in an active tenant, plus
one durable MongoDB consumer per tenant. Each session takes a Redis lease on its
own connection key, so two worker processes are safe: the second finds the lease
held and waits, and a session that loses its lease stops touching the broker
rather than racing. Restarting a session takes a change to its *shape* — its
provider, status, host, port, client id, account filter, or SnapTrade
credentials — so renaming a connection does not interrupt a live broker session.

## What isolation is *not*

* **Not a security boundary against a compromised host.** Tenants share one
  process, one database, and one Redis. A bug in the API is a cross-tenant bug.
* **Not a resource boundary.** One tenant's slow broker session shares an event
  loop with the others.
* **Not per-tenant encryption.** `SECRET_KEY` is platform-wide.

For a client who needs a hard boundary, run a second deployment with its own
database, Redis, and host, rather than relying on this model.

## Migration

`python -m app.migrate` moves a pre-tenancy installation onto the model. It is
idempotent, and `--dry-run` reports without writing. See
[migration-runbook.md](migration-runbook.md).
