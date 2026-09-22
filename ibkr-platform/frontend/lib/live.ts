import { QueryClient } from "@tanstack/react-query";
import { Account, Connection, Gateway, LiveEvent } from "./types";

type DiagnosticsCache = {
  gateway: Gateway;
  last_events: Record<string, Record<string, string>>;
  events: LiveEvent[];
  visibility_tests: Record<string, unknown>[];
};

export function applyEvent(client: QueryClient, event: LiveEvent) {
  const { event_type: type, account_id: account, data } = event;

  if (type === "alert.raised") {
    client.setQueryData<LiveEvent[]>(["alerts", "feed"], (rows) =>
      [event, ...(rows ?? []).filter((row) => row.event_id !== event.event_id)].slice(0, 200),
    );
  }
  client.setQueryData<DiagnosticsCache>(["diagnostics"], (current) => {
    if (!current) return current;
    const category = type.split(".")[0];
    const lastEvents =
      account === "*"
        ? current.last_events
        : {
            ...current.last_events,
            [account]: {
              ...current.last_events[account],
              [category]: event.timestamp,
            },
          };
    return {
      ...current,
      gateway:
        type === "gateway.updated"
          ? { ...current.gateway, ...data }
          : current.gateway,
      last_events: lastEvents,
      events: [event, ...current.events.filter((row) => row.event_id !== event.event_id)].slice(
        0,
        100,
      ),
    };
  });
  if (type === "gateway.updated") {

    client.setQueryData(["gateway"], (current) =>
      current ? { ...current, ...data } : data,
    );
    client.setQueryData<Connection[]>(["connections"], (rows) =>
      rows?.map((row) =>
        row.id === data.connection_id
          ? { ...row, state: { ...row.state, ...data } as Gateway }
          : row,
      ),
    );
    return;
  }
  if (type === "accounts.reconciled") {
    void client.invalidateQueries({ queryKey: ["accounts"] });
    return;
  }
  if (type === "account.updated") {
    client.setQueryData<Account[]>(["accounts"], (rows) =>
      rows?.map((row) =>
        row.account_id === account ? ({ ...row, ...data } as Account) : row,
      ),
    );
    void client.invalidateQueries({
      queryKey: ["accounts"],
      refetchType: "none",
    });
    return;
  }
  if (type === "snapshot.recorded") {
    void client.invalidateQueries({ queryKey: ["intraday"] });
    void client.invalidateQueries({ queryKey: ["history"] });
    return;
  }
  const kind = type.startsWith("position.")
    ? "positions"
    : type.startsWith("order")
      ? "orders"
      : type === "execution.created"
        ? "executions"
        : null;
  if (!kind) return;
  const key = [kind, account];
  const identity = (row: Record<string, unknown>) =>
    kind === "positions"
      ? row.con_id
      : kind === "orders"
        ? Number(row.perm_id) > 0
          ? `perm:${row.perm_id}`
          : `${row.client_id}:${row.order_id}`
        : row.execution_id;
  const removed =
    type === "position.closed" ||
    ["Filled", "Cancelled", "ApiCancelled", "Inactive"].includes(
      String(data.status),
    );
  const previous = client.getQueryData<Record<string, unknown>[]>(key);
  client.setQueryData<Record<string, unknown>[]>(key, (rows) => {
    if (!rows) return rows;
    if (type === "orders.reconciled")
      return data.orders as Record<string, unknown>[];
    const others = rows.filter(
      (row) =>
        identity(row) !== identity(data) &&
        !(
          kind === "orders" &&
          Number(data.perm_id) > 0 &&
          !Number(row.perm_id) &&
          row.client_id === data.client_id &&
          row.order_id === data.order_id
        ),
    );
    return removed
      ? others
      : [data, ...others].slice(0, kind === "executions" ? 100 : undefined);
  });
  const current = client.getQueryData<Record<string, unknown>[]>(key);
  if (
    kind !== "executions" &&
    (!previous || current?.length !== previous.length)
  )
    void client.invalidateQueries({ queryKey: ["accounts"] });
}

export function connectLive(
  client: QueryClient,
  accounts: string[],
  status: (connected: boolean) => void,
  factory: (url: string) => WebSocket = (url) => new WebSocket(url),
) {
  let socket: WebSocket;
  let stopped = false,
    attempts = 0;
  let retry: ReturnType<typeof setTimeout>;
  let heartbeat: ReturnType<typeof setInterval>;
  let lastPong = Date.now();
  const connect = () => {
    const configured = process.env.NEXT_PUBLIC_WS_URL;
    socket = factory(
      configured ||
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/live`,
    );
    socket.onopen = () => {
      lastPong = Date.now();
      socket.send(JSON.stringify({ type: "subscribe", accounts }));
      heartbeat = setInterval(() => {
        if (Date.now() - lastPong > 40000) {
          socket.close();
          return;
        }
        if (socket.readyState === 1)
          socket.send(JSON.stringify({ type: "ping" }));
      }, 15000);
    };
    socket.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as LiveEvent;
        if (event.event_type === "pong") {
          lastPong = Date.now();
          return;
        }
        if (event.event_type === "subscribed") {
          attempts = 0;
          status(true);

          void client.invalidateQueries();
          return;
        }
        applyEvent(client, event);
      } catch (error) {
        console.error("Invalid live event", error);
      }
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      clearInterval(heartbeat);
      status(false);
      if (!stopped)
        retry = setTimeout(
          connect,
          Math.min(30000, 1000 * 2 ** attempts++) + Math.random() * 300,
        );
    };
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    clearInterval(heartbeat);
    socket.close();
  };
}
