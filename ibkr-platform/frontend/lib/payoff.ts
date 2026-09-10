import { Position } from "./types";

export type Assumption = { spot: number; volatility: number; dividend: number };
export type RiskLeg = { position: Position; quantity: number; cost: number; multiplier: number; strike: number; days: number };
export const underlyingKey = (p: Position) => `${p.currency}:${p.symbol}`;
export function numeric(value: string | null | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The broker's own mark for an underlying: a held stock's price, else the
 *  `undPrice` IB computes for any option on it. Undefined when neither is live. */
export function brokerSpot(legs: RiskLeg[], key: string) {
  const stock = legs.find(l => underlyingKey(l.position) === key && l.position.sec_type === "STK" && (numeric(l.position.market_price) ?? 0) > 0);
  if (stock) return numeric(stock.position.market_price)!;
  const quoted = legs.find(l => underlyingKey(l.position) === key && (numeric(l.position.underlying_price) ?? 0) > 0);
  return quoted ? numeric(quoted.position.underlying_price)! : undefined;
}

export function prepareLegs(positions: Position[], today: string) {
  const legs: RiskLeg[] = [];
  const excluded: { position: Position; reason: string }[] = [];
  for (const p of positions) {
    const quantity = numeric(p.quantity), cost = numeric(p.average_cost);
    if (quantity === 0) continue;
    let reason = "";
    const multiplier = p.sec_type === "STK" ? 1 : numeric(p.multiplier);
    const strike = numeric(p.strike);
    const date = /^\d{8}$/.test(p.expiry) ? `${p.expiry.slice(0, 4)}-${p.expiry.slice(4, 6)}-${p.expiry.slice(6)}` : "";
    const timestamp = Date.parse(date);
    const validDate = Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
    const days = (timestamp - Date.parse(today)) / 86400000;
    if (!["STK", "OPT"].includes(p.sec_type)) reason = `Unsupported ${p.sec_type} contract`;
    else if (!p.currency || p.currency === "BASE" || !p.symbol) reason = "Missing instrument currency or underlying";
    else if (quantity === null || cost === null || cost < 0) reason = "Invalid quantity or average cost";
    else if (p.sec_type === "OPT" && (!multiplier || multiplier <= 0 || strike === null || strike <= 0 || !["C", "P"].includes(p.right))) reason = "Missing option terms or multiplier";
    else if (p.sec_type === "OPT" && (!validDate || days < 0)) reason = "Missing, invalid or past expiry";
    if (reason) excluded.push({ position: p, reason });
    else legs.push({ position: p, quantity: quantity!, cost: cost!, multiplier: multiplier!, strike: strike ?? 0, days: p.sec_type === "OPT" ? days : Infinity });
  }
  return { legs, excluded };
}

// Standard normal CDF, absolute error < 8e-8 (Abramowitz & Stegun 26.2.17).
function cdf(x: number) {
  const a = Math.abs(x), t = 1 / (1 + 0.2316419 * a);
  const tail = Math.exp(-a * a / 2) / Math.sqrt(2 * Math.PI) * t *
    (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - tail : tail;
}

export function optionValue(spot: number, strike: number, right: string, years: number, volatility: number, rate: number, dividend: number) {
  if (years <= 0) return Math.max(right === "C" ? spot - strike : strike - spot, 0);
  const s = spot * Math.exp(-dividend * years), k = strike * Math.exp(-rate * years);
  if (spot === 0 || volatility === 0) return Math.max(right === "C" ? s - k : k - s, 0);
  const v = volatility * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (rate - dividend + volatility * volatility / 2) * years) / v;
  return Math.max(0, right === "C" ? s * cdf(d1) - k * cdf(d1 - v) : k * cdf(v - d1) - s * cdf(-d1));
}

export function validAssumption(a: Assumption | undefined): a is Assumption {
  return !!a && Number.isFinite(a.spot) && a.spot > 0 && Number.isFinite(a.volatility) && a.volatility >= 0 && a.volatility <= 5 && Number.isFinite(a.dividend) && a.dividend >= 0 && a.dividend <= 1;
}

export function scenarioPnl(leg: RiskLeg, assumption: Assumption, shock: number, horizon: number, rate: number, terminal: boolean) {
  const spot = assumption.spot * (1 + shock / 100);
  const value = leg.position.sec_type === "STK" ? spot : optionValue(spot, leg.strike, leg.position.right, terminal ? 0 : Math.max(0, leg.days - horizon) / 365, assumption.volatility, rate, assumption.dividend);
  // IBKR derivative average cost already includes the contract multiplier.
  return leg.quantity * (value * leg.multiplier - leg.cost);
}

export function buildCurves(legs: RiskLeg[], assumptions: Record<string, Assumption>, range: number, horizon: number, rate: number) {
  const shocks = new Set(Array.from({ length: 81 }, (_, i) => -Math.min(range, 100) + (Math.min(range, 100) + range) * i / 80));
  shocks.add(0);
  for (const leg of legs) {
    if (leg.position.sec_type === "OPT") {
      const shock = (leg.strike / assumptions[underlyingKey(leg.position)].spot - 1) * 100;
      if (shock >= -Math.min(range, 100) && shock <= range) shocks.add(shock);
    }
  }
  return [...shocks].sort((a, b) => a - b).map((shock) => {
    let terminal = 0, modeled = 0;
    const accounts: Record<string, number> = {};
    for (const leg of legs) {
      const a = assumptions[underlyingKey(leg.position)];
      const pnl = scenarioPnl(leg, a, shock, horizon, rate, true);
      terminal += pnl;
      modeled += scenarioPnl(leg, a, shock, horizon, rate, false);
      accounts[leg.position.account_id] = (accounts[leg.position.account_id] ?? 0) + pnl;
    }
    return { shock, terminal, modeled, accounts };
  });
}

// Keep tails separate by underlying AND expiry: a calendar spread is not a capped payoff.
export function upsideRisks(legs: RiskLeg[]) {
  const groups = new Map<string, { calls: Map<string, number>; shares: number }>();
  for (const leg of legs) {
    const key = underlyingKey(leg.position);
    const group = groups.get(key) ?? { calls: new Map(), shares: 0 };
    if (leg.position.sec_type === "STK") group.shares += leg.quantity;
    else if (leg.position.right === "C") group.calls.set(leg.position.expiry, (group.calls.get(leg.position.expiry) ?? 0) + leg.quantity * leg.multiplier);
    groups.set(key, group);
  }
  return [...groups].filter(([, g]) => {
    const calls = [...g.calls.values()];
    // At a single expiry, long calls also cap a short stock position.
    // Across expiries, do not assume an expiring hedge protects later exposure.
    const callSlope = calls.reduce((n, q) => n + (calls.length === 1 ? q : Math.min(0, q)), 0);
    return g.shares + callSlope < 0;
  }).map(([key]) => key);
}
