# Migrating a running single-gateway install

The gateway this host already runs is **adopted**, not re-provisioned: its
`/opt/ibc/config.ini`, its port, and its `ibkr-gateway.service` unit stay
exactly where they are. The connection is recorded with `managed: false`, which
means provisioning will never rewrite its config and removing it will never
delete its files. A live broker session is not disturbed by the migration
itself — only by the service restart at the end.

## 1. Back up

```bash
mongodump --db ibkr_rms_live --out ~/backup-$(date +%F)
redis-cli -n 7 --rdb ~/backup-$(date +%F)/redis.rdb
cp /opt/ibc/config.ini ~/backup-$(date +%F)/ibc-config.ini
```

## 2. See what would change

```bash
make migrate-dry
```

Expect: create the bootstrap tenant, adopt the running gateway, move each
existing login into the tenant with the role and account grants it already had,
stamp durable documents with `tenant_id`, and copy live state and the newest
events into the tenant's Redis namespace.

## 3. Set the new configuration

Add `SECRET_KEY` to `backend/.env` — required only for SnapTrade, but set it
now so it is not a later surprise:

```bash
python3 -c "import secrets; print('SECRET_KEY=' + secrets.token_urlsafe(48))" >> backend/.env
```

Check that `IBKR_HOST`, `IBKR_PORT`, `IBC_CONFIG_PATH`, `IBC_LOG_DIRECTORY`, and
`GATEWAY_SERVICE` in `backend/.env` describe the gateway actually running.
Those five values are what the adopted connection is built from, and after the
migration nothing reads them again.

## 4. Migrate

```bash
make migrate
```

Redis keys are **copied, not moved**: `gateway:primary`, `accounts`,
`account:*` and `ibkr.events` are left in place as a rollback path until an
operator removes them. Only the newest 20,000 events are carried over — durable
history already lives in MongoDB, and the stream only backs the diagnostics
window and visibility tests.

## 5. Restart the API and worker

```bash
systemctl restart ibkr-api ibkr-worker
```

**Do not restart `ibkr-gateway`.** Nothing in this migration requires it, and on
this host a live restart performs a real IBKR login. With `ReadOnlyLogin=yes`
that login is unattended; with it off, it sends a push to the account holder's
phone that expires in 180 seconds.

The worker picks the adopted connection up on its next supervision pass, within
ten seconds, and reconnects to the same gateway on the same port.

## 6. Verify

```bash
curl -s localhost:8120/health
```

Sign in and confirm: the tenant name appears in the top bar, accounts and
positions are the ones that were there before, and **Connections** lists the
adopted gateway as `ENABLED` and `ADOPTED`.

Promote yourself to platform administrator to onboard further clients:

```bash
mongosh ibkr_rms_live --eval \
  'db.users.updateOne({email:"you@example.com"},{$set:{is_super_admin:true}})'
```

Sign out and back in. **Tenants** appears in the sidebar.

## Rolling back

Nothing is destroyed by the migration except the `_id` of `orders` and
`executions` documents, which are re-keyed under the tenant. To roll back,
restore the `mongodump` and redeploy the previous revision; the pre-tenancy
Redis keys are still in place, so live state does not need restoring.

## Onboarding the next client

1. **Tenants → Onboard a client.** Name the organisation. Optionally name an
   existing login as its owner.
2. Create their logins on the server: `python -m app.auth them@client.com
   --tenant acme-capital --role OWNER`.
3. Switch to that tenant, then **Connections → Add connection**.
   * *IB Gateway* provisions an instance and allocates a port. Add the client's
     IBKR API login, enable the connection, then start the gateway.
   * *SnapTrade* issues a single-use link. Send it to the client; nothing else
     is needed from them, and no IBKR password reaches this platform.
4. Grant their staff access under **Members**, with account grants for the
   `TRADER` and `VIEWER` roles.
