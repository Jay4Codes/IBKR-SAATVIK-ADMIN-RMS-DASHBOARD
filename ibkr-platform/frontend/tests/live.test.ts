import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEvent, connectLive } from "@/lib/live";
import { LiveEvent } from "@/lib/types";

const event = (type: string, data: Record<string, unknown>): LiveEvent => ({
  event_type: type,
  account_id: "DU1",
  timestamp: "",
  data,
});
afterEach(() => vi.useRealTimers());
describe("live cache", () => {
  it("keeps two-factor progress when the worker publishes gateway state", () => {
    const client = new QueryClient();
    client.setQueryData(["gateway"], {
      status: "DISCONNECTED",
      login_phase: "two_factor",
      two_factor_started_at: "2026-09-09T10:00:00+00:00",
      two_factor_timeout_seconds: 180,
    });

    applyEvent(
      client,
      event("gateway.updated", { status: "RECONNECTING", reconnect_attempts: 2 }),
    );
    expect(client.getQueryData(["gateway"])).toEqual({
      status: "RECONNECTING",
      reconnect_attempts: 2,
      login_phase: "two_factor",
      two_factor_started_at: "2026-09-09T10:00:00+00:00",
      two_factor_timeout_seconds: 180,
    });
  });

  it("accepts a gateway event before anything is cached", () => {
    const client = new QueryClient();
    applyEvent(client, event("gateway.updated", { status: "CONNECTED" }));
    expect(client.getQueryData(["gateway"])).toEqual({ status: "CONNECTED" });
  });

  it("updates only the matching conId and account", () => {
    const client = new QueryClient();
    client.setQueryData(
      ["positions", "DU1"],
      [
        { con_id: 1, quantity: "2" },
        { con_id: 2, quantity: "4" },
      ],
    );
    client.setQueryData(["positions", "DU2"], [{ con_id: 1, quantity: "8" }]);
    applyEvent(client, event("position.updated", { con_id: 1, quantity: "3" }));
    expect(client.getQueryData(["positions", "DU1"])).toEqual([
      { con_id: 1, quantity: "3" },
      { con_id: 2, quantity: "4" },
    ]);
    expect(client.getQueryData(["positions", "DU2"])).toEqual([
      { con_id: 1, quantity: "8" },
    ]);
    applyEvent(client, event("position.closed", { con_id: 1, quantity: "0" }));
    expect(client.getQueryData(["positions", "DU1"])).toEqual([
      { con_id: 2, quantity: "4" },
    ]);
  });
  it("reconciles missed orders and removes terminal rows", () => {
    const client = new QueryClient();
    client.setQueryData(
      ["orders", "DU1"],
      [{ client_id: 1, order_id: 2, status: "Submitted" }],
    );
    applyEvent(
      client,
      event("order.filled", { client_id: 1, order_id: 2, status: "Filled" }),
    );
    expect(client.getQueryData(["orders", "DU1"])).toEqual([]);
    applyEvent(
      client,
      event("orders.reconciled", {
        orders: [{ client_id: 3, order_id: 4, status: "Submitted" }],
      }),
    );
    expect(client.getQueryData(["orders", "DU1"])).toHaveLength(1);
  });
  it("enriches a fill without duplicating its row", () => {
    const client = new QueryClient();
    client.setQueryData(
      ["executions", "DU1"],
      [{ execution_id: "a", commission: null }],
    );
    applyEvent(
      client,
      event("execution.created", { execution_id: "a", commission: ".35" }),
    );
    expect(client.getQueryData(["executions", "DU1"])).toEqual([
      { execution_id: "a", commission: ".35" },
    ]);
  });
  it("shows disconnect, reconnects, resubscribes, and refreshes snapshots", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const status = vi.fn();
    const sockets: {
      onopen: () => void;
      onclose: () => void;
      onmessage: (message: { data: string }) => void;
      send: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      readyState: number;
    }[] = [];
    const factory = () => {
      const socket = {
        onopen: () => {},
        onclose: () => {},
        onmessage: () => {},
        send: vi.fn(),
        close: vi.fn(),
        readyState: 1,
      };
      sockets.push(socket);
      return socket as unknown as WebSocket;
    };
    const stop = connectLive(client, ["DU1"], status, factory);
    sockets[0].onopen();
    expect(sockets[0].send).toHaveBeenCalledWith(
      JSON.stringify({ type: "subscribe", accounts: ["DU1"] }),
    );
    sockets[0].onmessage({
      data: JSON.stringify({ event_type: "subscribed" }),
    });
    expect(status).toHaveBeenLastCalledWith(true);
    expect(invalidate).toHaveBeenCalled();
    sockets[0].onclose();
    expect(status).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(1400);
    expect(sockets).toHaveLength(2);
    sockets[1].onopen();
    expect(sockets[1].send).toHaveBeenCalled();
    stop();
    vi.advanceTimersByTime(60000);
    expect(sockets).toHaveLength(2);
  });
});
