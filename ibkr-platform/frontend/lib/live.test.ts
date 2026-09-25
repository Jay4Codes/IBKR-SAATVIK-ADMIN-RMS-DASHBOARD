import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { applyEvent } from "./live";
import { LiveEvent } from "./types";

function event(conId: number, price: string): LiveEvent {
  return {
    event_id: `${conId}-${price}`,
    event_type: "position.updated",
    account_id: "U1",
    timestamp: "2026-09-25T00:00:00Z",
    data: { con_id: conId, symbol: "SPX", market_price: price },
  };
}

describe("applyEvent positions", () => {
  it("updates a position in place instead of moving it to the front", () => {
    const client = new QueryClient();
    client.setQueryData(["positions", "U1"], [
      { con_id: 1, symbol: "SPX", market_price: "10" },
      { con_id: 2, symbol: "SPX", market_price: "20" },
      { con_id: 3, symbol: "SPX", market_price: "30" },
    ]);
    applyEvent(client, event(2, "21"));
    expect(client.getQueryData(["positions", "U1"])).toEqual([
      { con_id: 1, symbol: "SPX", market_price: "10" },
      { con_id: 2, symbol: "SPX", market_price: "21" },
      { con_id: 3, symbol: "SPX", market_price: "30" },
    ]);
  });

  it("appends a new contract and drops a closed one without reshuffling the rest", () => {
    const client = new QueryClient();
    client.setQueryData(["positions", "U1"], [
      { con_id: 1, symbol: "SPX" },
      { con_id: 2, symbol: "SPX" },
    ]);
    applyEvent(client, event(3, "5"));
    applyEvent(client, {
      event_id: "close-1",
      event_type: "position.closed",
      account_id: "U1",
      timestamp: "2026-09-25T00:00:00Z",
      data: { con_id: 1 },
    });
    expect(client.getQueryData(["positions", "U1"])).toEqual([
      { con_id: 2, symbol: "SPX" },
      { con_id: 3, symbol: "SPX", market_price: "5" },
    ]);
  });
});
