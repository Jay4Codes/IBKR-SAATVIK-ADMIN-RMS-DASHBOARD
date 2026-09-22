import { describe, expect, it } from "vitest";
import { buildCurves, daysToExpiry, expiryInstant, impliedVolatility, optionValue, prepareLegs, scenarioPnl, skewByExpiry, underlyingKey, upsideRisks, validAssumption } from "@/lib/payoff";
import { Position } from "@/lib/types";

const today = Date.parse("2026-09-09T14:00:00Z");
const position = (fields: Partial<Position> = {}): Position => ({ account_id: "A", con_id: 1, symbol: "XYZ", local_symbol: "", sec_type: "OPT", currency: "USD", expiry: "20261009", strike: "100", right: "C", multiplier: "100", quantity: "1", average_cost: "500", market_price: "5", market_value: "500", unrealized_pnl: "0", ...fields });
const assumption = { spot: 100, volatility: 0.2, dividend: 0 };
const leg = (fields: Partial<Position> = {}) => prepareLegs([position(fields)], today).legs[0];

describe("option valuation", () => {
  it("matches a known Black–Scholes call and put benchmark", () => {
    expect(optionValue(100, 100, "C", 1, 0.2, 0.05, 0)).toBeCloseTo(10.4506, 4);
    expect(optionValue(100, 100, "P", 1, 0.2, 0.05, 0)).toBeCloseTo(5.5735, 4);
  });
  it("satisfies put-call parity with dividends and a negative interest rate", () => {
    const call = optionValue(110, 100, "C", 0.7, 0.4, -0.02, 0.03);
    const put = optionValue(110, 100, "P", 0.7, 0.4, -0.02, 0.03);
    expect(call - put).toBeCloseTo(110 * Math.exp(-0.03 * 0.7) - 100 * Math.exp(0.02 * 0.7), 8);
  });
  it("handles expiry, zero volatility and a total underlying loss", () => {
    expect(optionValue(110, 100, "C", 0, 0.2, 0.05, 0)).toBe(10);
    expect(optionValue(90, 100, "P", 0, 0.2, 0.05, 0)).toBe(10);
    expect(optionValue(100, 100, "C", 1, 0, 0.05, 0)).toBeCloseTo(100 - 100 * Math.exp(-0.05), 8);
    expect(optionValue(0, 100, "P", 1, 0.2, 0.05, 0)).toBeCloseTo(100 * Math.exp(-0.05), 8);
  });
});

describe("position payoff and desk aggregation", () => {
  it("uses broker cost including multiplier exactly once, with signed quantities", () => {
    expect(scenarioPnl(leg(), assumption, 20, 0, 0, true)).toBe(1500);
    expect(scenarioPnl(leg({ quantity: "-2" }), assumption, 20, 0, 0, true)).toBe(-3000);
    expect(scenarioPnl(leg({ right: "P", quantity: "-1" }), assumption, -100, 0, 0, true)).toBe(-9500);
  });
  it("handles stock quantities without an option multiplier", () => {
    expect(scenarioPnl(leg({ sec_type: "STK", quantity: "-10", average_cost: "90" }), assumption, 20, 0, 0, true)).toBe(-300);
  });
  it("scales a name's own move by its beta against the scenario shock", () => {
    expect(scenarioPnl(leg({ sec_type: "STK", quantity: "1", average_cost: "100" }), { ...assumption, beta: 2 }, 10, 0, 0, true)).toBe(20);
  });
  it("models a bounded vertical spread including strikes between grid points", () => {
    const legs = prepareLegs([position(), position({ con_id: 2, strike: "107", quantity: "-1", average_cost: "200" })], today).legs;
    const curve = buildCurves(legs, { "USD:XYZ": assumption }, 50, 0, 0);
    expect(Math.min(...curve.map(p => p.terminal))).toBeCloseTo(-300);
    expect(Math.max(...curve.map(p => p.terminal))).toBeCloseTo(400);
    expect(curve.some(p => Math.abs(p.shock - 7) < 1e-8)).toBe(true);
    expect(upsideRisks(legs)).toEqual([]);
  });
  it("sums accounts at each shock and retains losses in the downside tail", () => {
    const legs = prepareLegs([position(), position({ account_id: "B", right: "P", quantity: "-1" })], today).legs;
    const curve = buildCurves(legs, { "USD:XYZ": assumption }, 200, 0, 0);
    for (const point of curve) expect(point.terminal).toBeCloseTo(point.accounts.A + point.accounts.B, 8);
    expect(curve[0].shock).toBe(-100);
    expect(curve[0].terminal).toBe(-10000);
    expect(curve.at(-1)?.shock).toBe(200);
  });
  it("keeps pre-expiry time value and converges to intrinsic at expiry", () => {
    const l = leg();
    expect(scenarioPnl(l, assumption, 0, 0, 0, false)).toBeGreaterThan(scenarioPnl(l, assumption, 0, 0, 0, true));
    expect(scenarioPnl(l, assumption, 0, l.days, 0, false)).toBe(scenarioPnl(l, assumption, 0, 0, 0, true));
  });
  it("anchors the current estimate to live broker P&L without changing terminal payoff", () => {
    const first = leg({ underlying_price: "100", market_price: "6.25", unrealized_pnl: "125" });
    const second = leg({ underlying_price: "100", market_price: "6.75", unrealized_pnl: "175" });
    const firstPoint = buildCurves([first], { "USD:XYZ": assumption }, 5, 0, 0).find(point => point.shock === 0)!;
    const secondPoint = buildCurves([second], { "USD:XYZ": assumption }, 5, 0, 0).find(point => point.shock === 0)!;
    expect(firstPoint.modeled).toBeCloseTo(125, 8);
    expect(secondPoint.modeled).toBeCloseTo(175, 8);
    expect(secondPoint.terminal).toBe(firstPoint.terminal);
  });
  it("flags naked calls and short stock without netting different expiries or underlyings", () => {
    expect(upsideRisks([leg({ quantity: "-1" })])).toEqual(["USD:XYZ"]);
    expect(upsideRisks([leg({ sec_type: "STK", quantity: "-1" })])).toEqual(["USD:XYZ"]);
    expect(upsideRisks([leg({ quantity: "-1" }), leg({ expiry: "20261109" })])).toEqual(["USD:XYZ"]);
    expect(upsideRisks([leg({ quantity: "-1" }), leg({ symbol: "ABC" })])).toEqual(["USD:XYZ"]);
    expect(upsideRisks([leg({ quantity: "-1" }), leg({ sec_type: "STK", quantity: "100" })])).toEqual([]);
    expect(upsideRisks([leg(), leg({ sec_type: "STK", quantity: "-100" })])).toEqual([]);
  });
});

describe("implied volatility inversion", () => {
  it("recovers the volatility that priced a benchmark option", () => {
    const price = optionValue(100, 100, "C", 1, 0.2, 0.05, 0);
    expect(impliedVolatility(price, 100, 100, "C", 1, 0.05, 0)).toBeCloseTo(0.2, 4);
    const put = optionValue(110, 100, "P", 0.7, 0.4, -0.02, 0.03);
    expect(impliedVolatility(put, 110, 100, "P", 0.7, -0.02, 0.03)).toBeCloseTo(0.4, 4);
  });
  it("rejects a price below intrinsic value", () => {
    expect(impliedVolatility(5, 150, 100, "C", 1, 0, 0)).toBe(null);
  });
  it("rejects a price no volatility up to 500% could produce", () => {
    expect(impliedVolatility(1000, 100, 100, "C", 0.01, 0, 0)).toBe(null);
  });
  it("rejects an expired, non-positive or already-expired input", () => {
    expect(impliedVolatility(5, 100, 100, "C", 0, 0, 0)).toBe(null);
    expect(impliedVolatility(0, 100, 100, "C", 1, 0, 0)).toBe(null);
    expect(impliedVolatility(5, 0, 100, "C", 1, 0, 0)).toBe(null);
  });
});

describe("skew from the desk's own book", () => {
  const held = (fields: Partial<Position> = {}) => position({
    expiry: "20991219", strike: "100", right: "P", market_price: "8", underlying_price: "100", ...fields,
  });
  it("groups held contracts by expiry and inverts each one's own mark", () => {
    const groups = skewByExpiry([
      held({ con_id: 1, expiry: "20991219", strike: "95" }),
      held({ con_id: 2, expiry: "20991219", strike: "105", right: "C", market_price: "9" }),
      held({ con_id: 3, expiry: "20991226", strike: "100" }),
    ], today, 0, 0);
    expect([...groups.keys()]).toEqual(["2099-12-19", "2099-12-26"]);
    const near = groups.get("2099-12-19")!;
    expect(near.map(p => p.strike)).toEqual([95, 105]);
    expect(near.every(p => p.iv !== null && p.iv > 0)).toBe(true);
  });
  it("skips a closed leg, a past expiry and a non-option position", () => {
    expect(skewByExpiry([held({ quantity: "0" })], today, 0, 0).size).toBe(0);
    expect(skewByExpiry([held({ expiry: "20200101" })], today, 0, 0).size).toBe(0);
    expect(skewByExpiry([held({ sec_type: "STK" })], today, 0, 0).size).toBe(0);
  });
});

describe("data coverage", () => {
  it.each([
    { sec_type: "FOP" }, { multiplier: null }, { strike: null }, { right: "" },
    { expiry: "20260230" }, { expiry: "202609" }, { expiry: "20260908" },
    { quantity: "NaN" }, { average_cost: "" }, { currency: "BASE" },
  ])("excludes incomplete or unsupported positions: %j", (fields) => {
    const result = prepareLegs([position(fields)], today);
    expect(result.legs).toHaveLength(0);
    expect(result.excluded).toHaveLength(1);
  });
  it("retains expiry-day contracts with the hours they have left, and ignores closed positions", () => {
    const sameDay = leg({ expiry: "20260909" });
    expect(sameDay.days).toBeCloseTo(6 / 24, 6);
    expect(sameDay.days).toBeGreaterThan(0);
    expect(prepareLegs([position({ quantity: "0" })], today)).toEqual({ legs: [], excluded: [] });
  });
  it("does not confuse an option mark with an underlying price or combine currencies", () => {
    expect(validAssumption({ ...assumption, spot: NaN })).toBe(false);
    expect(validAssumption({ ...assumption, spot: 0 })).toBe(false);
    expect(validAssumption({ ...assumption, volatility: -0.1 })).toBe(false);
    expect(underlyingKey(position())).not.toBe(underlyingKey(position({ currency: "EUR" })));
  });
});

describe("the exchange clock", () => {
  it("expires at 16:00 New York, through a daylight-saving change", () => {
    expect(expiryInstant("20260918")).toBe(Date.parse("2026-09-18T20:00:00Z"));
    expect(expiryInstant("20270115")).toBe(Date.parse("2027-01-15T21:00:00Z"));
    expect(Number.isNaN(expiryInstant("20260230"))).toBe(true);
    expect(Number.isNaN(expiryInstant("nonsense"))).toBe(true);
  });

  it("counts the hours left on expiry day instead of calling them zero", () => {
    const morning = Date.parse("2026-09-18T13:30:00Z");
    expect(daysToExpiry("20260918", morning)).toBeCloseTo(6.5 / 24, 9);
    expect(daysToExpiry("20260918", Date.parse("2026-09-18T20:00:01Z"))).toBeLessThan(0);
  });

  it("gives a four-day option more time than a calendar count does", () => {
    const at = Date.parse("2026-09-14T17:07:00Z");
    const exchange = daysToExpiry("20260918", at);
    expect(exchange).toBeGreaterThan(4);
    expect(exchange).toBeCloseTo(4.1201, 3);
  });

  it("does not move with the reader's timezone", () => {
    const at = Date.parse("2026-09-14T17:07:00Z");
    expect(daysToExpiry("20260918", at)).toBe(daysToExpiry("20260918", at));
    expect(expiryInstant("20260918")).toBe(Date.parse("2026-09-18T20:00:00Z"));
  });

  it("implies less volatility than a calendar count, from the same mark", () => {
    const at = Date.parse("2026-09-14T17:07:00Z");
    const clock = impliedVolatility(12.661815643310547, 7640.35, 7485, "P", daysToExpiry("20260918", at) / 365, 0.04, 0.012);
    const calendar = impliedVolatility(12.661815643310547, 7640.35, 7485, "P", 4 / 365, 0.04, 0.012);
    expect(clock).not.toBeNull();
    expect(clock!).toBeLessThan(calendar!);
    expect(clock! * 100).toBeCloseTo(19.386, 2);
    expect(calendar! * 100).toBeCloseTo(19.669, 2);
  });
});
