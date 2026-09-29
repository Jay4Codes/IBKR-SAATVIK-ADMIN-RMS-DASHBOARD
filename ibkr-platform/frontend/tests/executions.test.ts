import { describe, expect, it } from "vitest";
import { pastExpiry, type Fill } from "../lib/executions";
import type { Execution } from "../lib/types";

const row = (symbol: string, extra: Partial<Execution> = {}) =>
  ({ symbol, expiry: "", sec_type: "OPT", account_id: "U1", execution_id: "a.b.01.01", ...extra }) as Execution;
const single = (symbol: string): Fill => ({ key: symbol, lead: row(symbol), legs: [], combo: false });

const morning = Date.parse("2026-09-28T15:00:00Z");
const evening = Date.parse("2026-09-28T20:30:00Z");

describe("pastExpiry", () => {
  it("hides contracts that expired on an earlier day", () => {
    expect(pastExpiry(single("SPXW  260925P07600000"), morning)).toBe(true);
  });
  it("keeps today's expiry until the 4 pm New York close, then hides it", () => {
    expect(pastExpiry(single("SPXW  260928P07600000"), morning)).toBe(false);
    expect(pastExpiry(single("SPXW  260928P07600000"), evening)).toBe(true);
  });
  it("keeps future expiries and stock", () => {
    expect(pastExpiry(single("SPXW  260929C07800000"), evening)).toBe(false);
    expect(pastExpiry({ key: "s", lead: row("TSLA", { sec_type: "STK" }), legs: [], combo: false }, evening)).toBe(false);
  });
  it("keeps a combo while any leg is still live", () => {
    const combo: Fill = {
      key: "c", combo: true, lead: row("SPX", { sec_type: "BAG" }),
      legs: [row("SPXW  260925P07600000"), row("SPXW  260930P07550000")],
    };
    expect(pastExpiry(combo, morning)).toBe(false);
  });
});
