import { describe, expect, it } from "vitest";
import { strategyStats, type PricePoint } from "../lib/payoff";

const curve = (legs: { strike: number; right: "C" | "P"; qty: number }[], spot = 100): PricePoint[] => {
  const out: PricePoint[] = [];
  for (let i = 0; i <= 380; i++) {
    const price = spot * 0.05 + (spot * 1.9 * i) / 380;
    const terminal = legs.reduce(
      (sum, leg) => sum + leg.qty * (leg.right === "C" ? Math.max(0, price - leg.strike) : Math.max(0, leg.strike - price)) * 100,
      0,
    );
    out.push({ price, shock: 0, terminal, modeled: terminal, accounts: {} });
  }
  return out;
};
const stats = (points: PricePoint[]) => strategyStats(points, points, [], 100, 0, 0, 0, 0);

describe("strategyStats", () => {
  it("net long calls and puts: profit uncapped on the upside, loss capped", () => {
    const s = stats(curve([{ strike: 95, right: "P", qty: 19 }, { strike: 105, right: "C", qty: 15 }]));
    expect(s.uncappedUpside).toBe(true);
    expect(s.uncappedDownside).toBe(false);
    expect(s.maxLoss).toBe(0);
  });

  it("puts below the market cap at a price of zero, and that end counts as the max", () => {
    const s = stats(curve([{ strike: 95, right: "P", qty: 1 }]));
    expect(s.uncappedUpside).toBe(false);
    expect(s.uncappedDownside).toBe(false);
    expect(s.maxProfit).toBeCloseTo(9500, 0);
  });

  it("net short calls: the loss is uncapped", () => {
    const s = stats(curve([{ strike: 105, right: "C", qty: -2 }]));
    expect(s.uncappedDownside).toBe(true);
    expect(s.uncappedUpside).toBe(false);
  });

  it("a defined-risk condor is capped both ways", () => {
    const s = stats(curve([
      { strike: 90, right: "P", qty: 1 }, { strike: 95, right: "P", qty: -1 },
      { strike: 105, right: "C", qty: -1 }, { strike: 110, right: "C", qty: 1 },
    ]));
    expect(s.uncappedUpside).toBe(false);
    expect(s.uncappedDownside).toBe(false);
    expect(s.maxLoss).toBeCloseTo(-500, 0);
  });
});
