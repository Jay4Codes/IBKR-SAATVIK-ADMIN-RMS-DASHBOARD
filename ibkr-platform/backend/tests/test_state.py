import json
from datetime import timedelta

from app.domain import Event, GatewayState, Position, now
from app.state import StateRepository
from tests.conftest import CONNECTION, OTHER_CONNECTION, OTHER_TENANT, TENANT


def position(quantity="2", con_id=1):
    return Position(
        account_id="DU1", con_id=con_id, symbol="SAME", sec_type="OPT", quantity=quantity, average_cost="1200"
    )


async def test_atomic_state_event_and_close(stores, repo, keys):
    redis, _ = stores
    for con_id in (1, 2):
        await repo.publish(
            Event(
                event_type="position.updated",
                account_id="DU1",
                data=position(con_id=con_id).model_dump(mode="json"),
            )
        )
    assert len(await repo.rows("DU1", "positions")) == 2
    await repo.publish(
        Event(event_type="position.closed", account_id="DU1", data=position("0").model_dump(mode="json"))
    )
    assert [p["con_id"] for p in await repo.rows("DU1", "positions")] == [2]
    events = await redis.xrange(keys.events)
    assert len(events) == 3
    assert json.loads(events[-1][1]["event"])["account_id"] == "DU1"
    assert events[-1][1]["connection_id"] == CONNECTION


async def test_stale_gateway(stores, repo, keys):
    redis, _ = stores
    state = GatewayState(
        status="CONNECTED",
        last_heartbeat=now() - timedelta(seconds=60),
        subscriptions={"positions": "ACTIVE"},
    )
    await redis.set(keys.gateway(CONNECTION), state.model_dump_json())
    gateway = await repo.gateway()
    assert gateway["status"] == "DEGRADED"
    assert gateway["subscriptions"]["positions"] == "STALE"


async def test_orders_reconcile_and_terminal(repo):
    data = {"account_id": "DU1", "order_id": 1, "client_id": 2, "status": "Submitted"}
    await repo.publish(Event(event_type="order.updated", account_id="DU1", data=data))
    assert len(await repo.rows("DU1", "orders")) == 1
    await repo.publish(Event(event_type="order.filled", account_id="DU1", data={**data, "status": "Filled"}))
    assert not await repo.rows("DU1", "orders")
    await repo.publish(Event(event_type="order.updated", account_id="DU1", data=data))
    await repo.publish(Event(event_type="orders.reconciled", account_id="DU1", data={"orders": []}))
    assert not await repo.rows("DU1", "orders")


async def test_unbound_manual_orders_do_not_collide(repo):
    data = {"account_id": "DU1", "order_id": 0, "client_id": 0, "status": "Submitted"}
    for perm_id in (123, 456):
        await repo.publish(
            Event(event_type="order.updated", account_id="DU1", data={**data, "perm_id": perm_id})
        )
    assert len(await repo.rows("DU1", "orders")) == 2


async def test_two_tenants_never_share_live_state(stores):
    redis, _ = stores
    one = StateRepository(redis, TENANT, CONNECTION)
    two = StateRepository(redis, OTHER_TENANT, OTHER_CONNECTION)
    for repo, quantity in ((one, "5"), (two, "9")):
        await repo.publish(
            Event(
                event_type="position.updated",
                account_id="DU1",
                data=position(quantity).model_dump(mode="json"),
            )
        )
    assert (await one.rows("DU1", "positions"))[0]["quantity"] == "5"
    assert (await two.rows("DU1", "positions"))[0]["quantity"] == "9"
    assert len(await redis.xrange(one.keys.events)) == 1
    assert len(await redis.xrange(two.keys.events)) == 1


async def test_reconciliation_only_drops_the_reporting_connection_accounts(stores):
    redis, _ = stores
    first = StateRepository(redis, TENANT, CONNECTION)
    second = StateRepository(redis, TENANT, OTHER_CONNECTION)
    await first.publish(Event(event_type="accounts.reconciled", account_id="*", data={"accounts": ["A", "B"]}))
    await second.publish(Event(event_type="accounts.reconciled", account_id="*", data={"accounts": ["C"]}))
    assert await first.accounts() == {"A", "B", "C"}
    await first.publish(Event(event_type="accounts.reconciled", account_id="*", data={"accounts": ["A"]}))
    assert await first.accounts() == {"A", "C"}
