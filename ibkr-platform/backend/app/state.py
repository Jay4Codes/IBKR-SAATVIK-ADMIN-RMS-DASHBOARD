"""Live state and the event stream, namespaced per tenant.

Every key is derived from a `TenantKeys` built at construction, so a repository
handed to one tenant's request or worker session physically cannot address
another tenant's live state.
"""

import json
from datetime import datetime

from app.domain import Event, GatewayState, now, order_key
from app.tenancy import TenantKeys

TERMINAL = {"Filled", "Cancelled", "ApiCancelled", "Inactive"}

#: A worker heartbeat older than this means the session is no longer proving
#: itself alive, whatever the last state it managed to publish said.
STALE_HEARTBEAT_SECONDS = 35


class StateRepository:
    def __init__(self, redis, tenant_id: str, connection_id: str | None = None):
        self.redis = redis
        self.tenant_id = tenant_id
        self.connection_id = connection_id
        self.keys = TenantKeys(tenant_id)

    def for_connection(self, connection_id: str) -> "StateRepository":
        return StateRepository(self.redis, self.tenant_id, connection_id)

    def _connection(self, connection_id: str | None = None) -> str:
        chosen = connection_id or self.connection_id
        if not chosen:
            raise ValueError("This operation needs a broker connection")
        return chosen

    async def publish(self, event: Event, connection_id: str | None = None):
        """Apply one event to live state and append it to the tenant's stream.

        The state write and the stream append share a transaction, so a reader
        never sees a stream entry describing state that was not written.
        """
        connection = self._connection(connection_id)
        data = event.data
        account = event.account_id
        keys = self.keys
        async with self.redis.pipeline(transaction=True) as pipe:
            if event.event_type.startswith("gateway."):
                pipe.set(keys.gateway(connection), json.dumps(data))
            elif event.event_type == "accounts.reconciled":
                # Reconciliation is scoped to the connection that reported it:
                # accounts belonging to the tenant's *other* connections must
                # survive, so only this connection's departed accounts are
                # dropped from the tenant-wide set.
                current = set(data["accounts"])
                dropped = set(await self.redis.smembers(keys.connection_accounts(connection))) - current
                if dropped:
                    pipe.srem(keys.accounts, *dropped)
                    for account in dropped:
                        pipe.delete(keys.account_state(account))
                pipe.delete(keys.connection_accounts(connection))
                if current:
                    pipe.sadd(keys.connection_accounts(connection), *current)
                    pipe.sadd(keys.accounts, *current)
            elif event.event_type == "account.updated":
                pipe.sadd(keys.accounts, account)
                pipe.sadd(keys.connection_accounts(connection), account)
                pipe.set(keys.account_state(account), json.dumps(data))
            elif event.event_type == "orders.reconciled":
                key = keys.account_rows(account, "orders")
                pipe.delete(key)
                for row in data["orders"]:
                    if row["status"] not in TERMINAL:
                        pipe.hset(key, order_key(row), json.dumps(row))
            elif event.event_type.startswith("position."):
                key = keys.account_rows(account, "positions")
                if event.event_type == "position.closed":
                    pipe.hdel(key, str(data["con_id"]))
                else:
                    pipe.hset(key, str(data["con_id"]), json.dumps(data))
            elif event.event_type.startswith("order."):
                key = keys.account_rows(account, "orders")
                identity = order_key(data)
                if data.get("perm_id", 0) > 0:
                    pipe.hdel(key, f"{account}:{data['client_id']}:{data['order_id']}")
                if data["status"] in TERMINAL:
                    pipe.hdel(key, identity)
                else:
                    pipe.hset(key, identity, json.dumps(data))
            pipe.xadd(
                keys.events,
                {"event": event.model_dump_json(), "connection_id": connection},
            )
            if account != "*":
                pipe.hset(
                    keys.diagnostics(account),
                    event.event_type.split(".")[0],
                    event.timestamp.isoformat(),
                )
            await pipe.execute()

    async def set_login(self, connection_id: str, snapshot: dict, ttl: int):
        await self.redis.set(self.keys.login(connection_id), json.dumps(snapshot), ex=ttl)

    async def login_snapshot(self, connection_id: str) -> dict | None:
        raw = await self.redis.get(self.keys.login(connection_id))
        return json.loads(raw) if raw else None

    async def clear_login(self, connection_id: str):
        await self.redis.delete(self.keys.login(connection_id))

    async def stream_gateway(self, connection_id: str, state: dict):
        """Push a gateway change onto the stream without rewriting worker state.

        The login poller and the worker each own half of the gateway picture;
        this lets the poller announce its half without clobbering the other.
        """
        event = Event(event_type="gateway.login", account_id="*", data=state)
        await self.redis.xadd(
            self.keys.events, {"event": event.model_dump_json(), "connection_id": connection_id}
        )

    async def gateway(self, connection_id: str | None = None) -> dict:
        connection = self._connection(connection_id)
        raw = await self.redis.get(self.keys.gateway(connection))
        state = json.loads(raw) if raw else GatewayState().model_dump(mode="json")
        heartbeat = state.get("last_heartbeat")
        if state["status"] == "CONNECTED" and (
            not heartbeat
            or (now() - datetime.fromisoformat(heartbeat)).total_seconds() > STALE_HEARTBEAT_SECONDS
        ):
            state["status"] = "DEGRADED"
            state["last_error"] = "Worker heartbeat is stale"
            state["subscriptions"] = {key: "STALE" for key in state.get("subscriptions", {})}
        login = await self.redis.get(self.keys.login(connection))
        if login:
            state.update(json.loads(login))
        state["connection_id"] = connection
        return state

    async def account(self, account: str):
        raw = await self.redis.get(self.keys.account_state(account))
        return json.loads(raw) if raw else None

    async def accounts(self) -> set[str]:
        return await self.redis.smembers(self.keys.accounts)

    async def knows_account(self, account: str) -> bool:
        return bool(await self.redis.sismember(self.keys.accounts, account))

    async def rows(self, account: str, kind: str):
        return [json.loads(value) for value in await self.redis.hvals(self.keys.account_rows(account, kind))]

    async def target(self, connection_id: str) -> dict:
        raw = await self.redis.get(self.keys.target(connection_id))
        return json.loads(raw) if raw else {}

    async def set_target(self, connection_id: str, payload: dict):
        await self.redis.set(self.keys.target(connection_id), json.dumps(payload))
