import { describe, expect, it } from "vitest";
import { prepareLegs } from "@/lib/payoff";
import { breachClass, buildRows, expiryBucket, expiryLabel, groupKey, NO_EXPIRY, percentOf, preferredFocus } from "@/lib/risk-lenses";
import { Position } from "@/lib/types";

const today = Date.parse("2026-09-22T14:00:00Z");
const position = (fields: Partial<Position> = {}): Position => ({
  account_id: "A", con_id: 1, symbol: "SPX", local_symbol: "", sec_type: "OPT",
  currency: "USD", expiry: "20260923", strike: "7700", right: "C", multiplier: "100",
  quantity: "1", average_cost: "500", market_price: "5", market_value: "500",
  unrealized_pnl: "0", underlying_price: "7650", ...fields,
});

describe("expiry buckets", () => {
  it("reads the exchange calendar, not the browser's", () => {
    expect(expiryBucket("20260922", today)).toBe("Today");
    expect(expiryBucket("20260923", today)).toBe("Tomorrow");
    expect(expiryBucket("20260928", today)).toBe("This week");
    expect(expiryBucket("20261016", today)).toBe("Later");
    expect(expiryBucket(NO_EXPIRY, today)).toBe("No expiry");
  });
  it("names a stock without inventing a date", () => {
    expect(expiryLabel(NO_EXPIRY)).toBe("Stock, no expiry");
    expect(expiryLabel("20260923")).toBe("2026-09-23");
  });
});

describe("lens rows", () => {
  it("groups the same legs by asset, expiry or account", () => {
    const { legs } = prepareLegs([
      position(),
      position({ account_id: "B", con_id: 2, symbol: "NVDA", sec_type: "STK", expiry: "", average_cost: "80", market_price: "100" }),
    ], today);
    const assumptions = {
      "USD:SPX": { spot: 7650, volatility: 0.2, dividend: 0 },
      "USD:NVDA": { spot: 100, volatility: 0.3, dividend: 0 },
    };
    const options = { range: 10, horizon: 0, rate: 0, levels: [-5, 5], now: today };
    const byAsset = buildRows("asset", legs, assumptions, options);
    expect(byAsset.map(row => row.label)).toEqual(["SPX", "NVDA"]);
    expect(byAsset[0].at[-5]).toBeDefined();
    expect(byAsset[0].spark.length).toBeGreaterThan(2);

    const byAccount = buildRows("account", legs, assumptions, options);
    expect(byAccount.map(row => row.id).sort()).toEqual(["A", "B"]);

    expect(groupKey("expiry", legs[1])).toBe(NO_EXPIRY);
  });
});

describe("focus", () => {
  it("opens the asset lens on SPX when that name is in the book", () => {
    const rows = [{ id: "USD:NVDA", label: "NVDA" }, { id: "USD:SPX", label: "SPX" }, { id: "USD:QQQ", label: "QQQ" }];
    expect(preferredFocus("asset", rows)).toBe("USD:SPX");
    expect(preferredFocus("account", [{ id: "B", label: "B" }, { id: "A", label: "A" }])).toBe("A");
  });
});

describe("denomination", () => {
  it("shades a loss once it crosses five and ten percent of NLV", () => {
    expect(percentOf(-40, 1000)).toBeCloseTo(-4);
    expect(breachClass(-4)).toBe("");
    expect(breachClass(-5)).toBe("warn");
    expect(breachClass(-10)).toBe("breach");
    expect(breachClass(null)).toBe("");
  });
});
