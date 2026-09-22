import { describe, expect, it } from "vitest";
import { breakevens, buildPriceCurve, prepareLegs, previousClose, priceCdf, strategyStats } from "@/lib/payoff";
import { Position } from "@/lib/types";
import { scaleTicks, tickPlacement, tickWeight } from "@/components/strategy-payoff";

function opt(fields: Partial<Position>): Position {
  return {
    account_id: "U1", con_id: 1, symbol: "SPX", local_symbol: "", sec_type: "OPT",
    currency: "USD", expiry: "20991231", strike: "7500", right: "P", multiplier: "100",
    quantity: "1", average_cost: "1000", market_price: "10", market_value: "1000",
    unrealized_pnl: "0", underlying_price: "7656.98", ...fields,
  } as Position;
}

const BOOK = [
  opt({ con_id: 1, strike: "7730", right: "C", quantity: "1", average_cost: "2346.6303" }),
  opt({ con_id: 2, strike: "7775", right: "C", quantity: "1", average_cost: "1221.6303" }),
  opt({ con_id: 3, strike: "7510", right: "P", quantity: "-2", average_cost: "2933.8697" }),
  opt({ con_id: 4, strike: "7485", right: "P", quantity: "1", average_cost: "1229.7303" }),
  opt({ con_id: 5, strike: "7750", right: "C", quantity: "-2", average_cost: "1773.8697" }),
  opt({ con_id: 6, strike: "7530", right: "P", quantity: "1", average_cost: "3326.6303" }),
];

const AT = Date.parse("2026-09-14T17:07:00Z");
const SPOT = 7656.98;
const ASSUMPTIONS = { "USD:SPX": { spot: SPOT, volatility: 0.17, dividend: 0.012 } };

function curves(range: number) {
  const { legs } = prepareLegs(BOOK, AT);
  return { legs, points: buildPriceCurve(legs, ASSUMPTIONS, "USD:SPX", range, 0, 0.04) };
}

describe("strategy payoff", () => {
  it("samples every held strike exactly, so the kinks are not rounded off", () => {
    const { points } = curves(15);
    for (const strike of [7485, 7510, 7530, 7730, 7750, 7775]) {
      expect(points.some(p => p.price === strike)).toBe(true);
    }
    expect(points.map(p => p.price)).toEqual([...points.map(p => p.price)].sort((a, b) => a - b));
  });

  it("finds the breakevens the broker's own tool reports", () => {
    const { legs, points } = curves(15);
    const wide = buildPriceCurve(legs, ASSUMPTIONS, "USD:SPX", 95, 0, 0.04);
    const stats = strategyStats(points, wide, legs, SPOT, 0.17, 4 / 365, 0.04, 0.012, -1265.36);
    expect(stats.breakevens).toHaveLength(2);
    expect(stats.breakevens[0]).toBeGreaterThan(7480);
    expect(stats.breakevens[0]).toBeLessThan(7500);
    expect(stats.breakevens[1]).toBeGreaterThan(7760);
    expect(stats.breakevens[1]).toBeLessThan(7780);
  });

  it("reads a defined-risk book as capped on both sides", () => {
    const { legs, points } = curves(15);
    const wide = buildPriceCurve(legs, ASSUMPTIONS, "USD:SPX", 95, 0, 0.04);
    const stats = strategyStats(points, wide, legs, SPOT, 0.17, 4 / 365, 0.04, 0.012);
    expect(stats.uncappedUpside).toBe(false);
    expect(stats.uncappedDownside).toBe(false);
    expect(stats.netCredit).toBeCloseTo(1290.86, 2);
  });

  it("takes its extremes from the strategy, not from the plotted window", () => {
    const { legs } = curves(3);
    const narrow = buildPriceCurve(legs, ASSUMPTIONS, "USD:SPX", 3, 0, 0.04);
    const wide = buildPriceCurve(legs, ASSUMPTIONS, "USD:SPX", 95, 0, 0.04);
    const zoomedIn = strategyStats(narrow, wide, legs, SPOT, 0.17, 4 / 365, 0.04, 0.012);
    const zoomedOut = strategyStats(wide, wide, legs, SPOT, 0.17, 4 / 365, 0.04, 0.012);
    expect(zoomedIn.maxLoss).toBeCloseTo(zoomedOut.maxLoss, 6);
    expect(zoomedIn.maxProfit).toBeCloseTo(zoomedOut.maxProfit, 6);
  });

  it("folds booked P&L into every headline number", () => {
    const { legs, points } = curves(15);
    const wide = buildPriceCurve(legs, ASSUMPTIONS, "USD:SPX", 95, 0, 0.04);
    const gross = strategyStats(points, wide, legs, SPOT, 0.17, 4 / 365, 0.04, 0.012);
    const net = strategyStats(points, wide, legs, SPOT, 0.17, 4 / 365, 0.04, 0.012, -1265.36);
    expect(net.maxProfit).toBeCloseTo(gross.maxProfit - 1265.36, 2);
    expect(net.maxLoss).toBeCloseTo(gross.maxLoss - 1265.36, 2);
    expect(gross.breakevens).toHaveLength(0);
    expect(net.breakevens).toHaveLength(2);
    expect(gross.chanceOfProfit).toBeGreaterThan(0.99);
    expect(net.chanceOfProfit!).toBeLessThan(gross.chanceOfProfit!);
  });

  it("prices the probability of a level with a sane distribution", () => {
    expect(priceCdf(SPOT, SPOT, 0.17, 4 / 365, 0.04, 0.012)).toBeCloseTo(0.5, 1);
    expect(priceCdf(SPOT * 0.5, SPOT, 0.17, 4 / 365, 0.04, 0.012)).toBeLessThan(0.001);
    expect(priceCdf(SPOT * 2, SPOT, 0.17, 4 / 365, 0.04, 0.012)).toBeGreaterThan(0.999);
    const near = priceCdf(SPOT * 1.02, SPOT, 0.17, 1 / 365, 0.04, 0.012);
    const far = priceCdf(SPOT * 1.02, SPOT, 0.17, 30 / 365, 0.04, 0.012);
    expect(far).toBeLessThan(near);
  });

  it("interpolates a crossing rather than snapping to a sample", () => {
    const points = [
      { price: 100, shock: 0, terminal: -10, modeled: 0, accounts: {} },
      { price: 110, shock: 0, terminal: 10, modeled: 0, accounts: {} },
    ];
    expect(breakevens(points)).toEqual([105]);
    expect(breakevens(points, 10)).toEqual([100]);
    expect(breakevens(points, 50)).toEqual([]);
  });
});

describe("the day's change", () => {
  it("measures against the previous session close", () => {
    const { legs } = prepareLegs(
      BOOK.map(p => ({ ...p, underlying_prev_close: "7656.98" })),
      AT,
    );
    expect(previousClose(legs, "USD:SPX")).toBe(7656.98);
  });

  it("has no baseline to invent when the broker sends none", () => {
    const { legs } = prepareLegs(BOOK, AT);
    expect(previousClose(legs, "USD:SPX")).toBeUndefined();
    const { legs: blank } = prepareLegs(
      BOOK.map(p => ({ ...p, underlying_prev_close: "0" })),
      AT,
    );
    expect(previousClose(blank, "USD:SPX")).toBeUndefined();
  });
});

describe("the strike ladder's price scale", () => {
  it("steps in round numbers, inside the span, whatever the zoom", () => {
    const ticks = scaleTicks(7400, 7900);
    expect(ticks.length).toBeGreaterThan(4);
    expect(ticks.length).toBeLessThan(16);
    expect(Math.min(...ticks)).toBeGreaterThanOrEqual(7400);
    expect(Math.max(...ticks)).toBeLessThanOrEqual(7900);
    const step = ticks[1] - ticks[0];
    expect([1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500]).toContain(step);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i] - ticks[i - 1]).toBeCloseTo(step, 6);
  });

  it("stays sane when zoomed hard in or out", () => {
    expect(scaleTicks(7650, 7655).length).toBeGreaterThan(2);
    expect(scaleTicks(400, 15000).length).toBeGreaterThan(4);
    expect(scaleTicks(7650, 7650)).toEqual([]);
    expect(scaleTicks(7900, 7400)).toEqual([]);
  });
});

describe("strike rail placement", () => {
  const pin = (strike: number, quantity = 1, right = "P", expiry = "20260918") =>
    ({ strike, right, quantity, expiry });

  it("sits every strike on the price axis without stacking rows", () => {
    const placed = tickPlacement([pin(7485), pin(7510, -2), pin(7530)], 6800, 8600);
    expect(placed.map(p => p.nudge)).toEqual([0, 0, 0]);
    expect(placed[1].x).toBeCloseTo(((7510 - 6800) / 1800) * 100);
  });

  it("nudges overlapping same-strike pins sideways instead of growing taller", () => {
    const placed = tickPlacement([
      pin(7770, 1, "C", "20260918"),
      pin(7770, 2, "C", "20261016"),
    ], 6800, 8600);
    expect(placed.map(p => p.nudge)).toEqual([0, 1]);
    expect(placed[0].x).toBe(placed[1].x);
  });

  it("caps quantity so tick height cannot grow without bound", () => {
    expect(tickWeight(1)).toBe(1);
    expect(tickWeight(-12)).toBe(4);
  });
})
