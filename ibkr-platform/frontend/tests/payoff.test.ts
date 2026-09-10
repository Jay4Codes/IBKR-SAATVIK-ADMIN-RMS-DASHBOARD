import { describe, expect, it } from "vitest";
import { buildCurves, optionValue, prepareLegs, scenarioPnl, underlyingKey, upsideRisks, validAssumption } from "@/lib/payoff";
import { Position } from "@/lib/types";

const today = "2026-09-09";
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
    expect(scenarioPnl(l, assumption, 0, 30, 0, false)).toBe(scenarioPnl(l, assumption, 0, 0, 0, true));
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
  it("retains expiry-day contracts and ignores closed positions", () => {
    expect(leg({ expiry: "20260909" }).days).toBe(0);
    expect(prepareLegs([position({ quantity: "0" })], today)).toEqual({ legs: [], excluded: [] });
  });
  it("does not confuse an option mark with an underlying price or combine currencies", () => {
    expect(validAssumption({ ...assumption, spot: NaN })).toBe(false);
    expect(validAssumption({ ...assumption, spot: 0 })).toBe(false);
    expect(validAssumption({ ...assumption, volatility: -0.1 })).toBe(false);
    expect(underlyingKey(position())).not.toBe(underlyingKey(position({ currency: "EUR" })));
  });
});
