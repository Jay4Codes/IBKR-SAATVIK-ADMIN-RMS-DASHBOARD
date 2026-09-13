import { Position } from "./types";

export type Assumption = { spot: number; volatility: number; dividend: number };
export type RiskLeg = { position: Position; quantity: number; cost: number; multiplier: number; strike: number; days: number };
export const RMS_SHOCKS = [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5] as const;
export const underlyingKey = (p: Position) => `${p.currency}:${p.symbol}`;
export function numeric(value: string | null | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The reference mark for an underlying: a held stock's price, else whichever
 *  feed stamped `underlying_price` on an option — IB's `undPrice`, or a Massive
 *  loader. Undefined when neither is available.
 *
 *  The source travels with the price because they are not interchangeable: a
 *  vendor plan entitled only to daily aggregates answers with the *previous
 *  session's* close, which must not be presented as a live mark in a risk tool. */
export function brokerSpot(legs: RiskLeg[], key: string): { price: number; source: string } | undefined {
  const stock = legs.find(l => underlyingKey(l.position) === key && l.position.sec_type === "STK" && (numeric(l.position.market_price) ?? 0) > 0);
  if (stock) return { price: numeric(stock.position.market_price)!, source: "ib_stock_mark" };
  const quoted = legs.find(l => underlyingKey(l.position) === key && (numeric(l.position.underlying_price) ?? 0) > 0);
  if (!quoted) return undefined;
  return { price: numeric(quoted.position.underlying_price)!, source: quoted.position.underlying_source || "ib_und_price" };
}

/** How a reference price should be described to whoever is reading the curve. */
export function spotLabel(source: string): string {
  if (source.endsWith("_cached")) return "Stored last underlying price — not live";
  if (source === "aggs_prev" || source === "stocks_snapshot_prev") return "Massive — previous session close, not a live mark";
  if (source.startsWith("massive_") || ["indices_snapshot", "options_snapshot", "stocks_snapshot"].includes(source)) return "Massive live snapshot";
  if (source === "ib_stock_mark") return "Live broker mark — held stock";
  return "Live broker mark";
}

/** "YYYYMMDD" (IBKR's expiry format) as "YYYY-MM-DD", or "" if it is not a real calendar date. */
export function expiryDate(expiry: string): string {
  const date = /^\d{8}$/.test(expiry) ? `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6)}` : "";
  if (!date) return "";
  const timestamp = Date.parse(date);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date ? date : "";
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
    const date = expiryDate(p.expiry);
    const validDate = date !== "";
    const days = (Date.parse(date) - Date.parse(today)) / 86400000;
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

/** The volatility that reprices to `price` under the same Black–Scholes model
 *  `optionValue` uses, found by bisection since the price is monotonic in
 *  volatility. Returns null for anything that cannot be inverted: an expired
 *  or non-positive input, or a price below intrinsic value or above what even
 *  500% volatility would produce (a stale or crossed broker mark). */
export function impliedVolatility(price: number, spot: number, strike: number, right: string, years: number, rate: number, dividend: number): number | null {
  if (!(price > 0) || !(spot > 0) || !(strike > 0) || !(years > 0)) return null;
  const intrinsic = Math.max(right === "C" ? spot - strike : strike - spot, 0);
  if (price < intrinsic) return null;
  let lo = 0, hi = 5;
  if (optionValue(spot, strike, right, years, hi, rate, dividend) < price) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (optionValue(spot, strike, right, years, mid, rate, dividend) > price) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

export type SkewPoint = { strike: number; iv: number; right: string };

/** Implied vol at each strike the desk actually holds, grouped by expiry.
 *
 *  Unlike a vendor chain this only covers strikes the account has a position
 *  in — sparse, but it needs nothing beyond data already on the position: the
 *  broker's own option mark is inverted against the same Black–Scholes model
 *  `optionValue` prices with, using the broker's live underlying mark as spot.
 *  Every held contract contributes its own point (not just the OTM side), so
 *  a straddle shows both legs rather than only one surviving per strike. */
export function skewByExpiry(positions: Position[], today: string, rate: number, dividend: number): Map<string, SkewPoint[]> {
  const groups = new Map<string, SkewPoint[]>();
  for (const p of positions) {
    if (p.sec_type !== "OPT" || !["C", "P"].includes(p.right) || numeric(p.quantity) === 0) continue;
    const date = expiryDate(p.expiry);
    if (!date) continue;
    const days = (Date.parse(date) - Date.parse(today)) / 86400000;
    if (days <= 0) continue;
    const strike = numeric(p.strike);
    const price = numeric(p.market_price);
    const spot = numeric(p.underlying_price);
    if (strike === null || strike <= 0 || price === null || spot === null || spot <= 0) continue;
    const iv = impliedVolatility(price, spot, strike, p.right, days / 365, rate, dividend);
    if (iv === null) continue;
    const points = groups.get(date) ?? [];
    points.push({ strike, iv, right: p.right });
    groups.set(date, points);
  }
  for (const points of groups.values()) points.sort((a, b) => a.strike - b.strike);
  return groups;
}

export function validAssumption(a: Assumption | undefined): a is Assumption {
  return !!a && Number.isFinite(a.spot) && a.spot > 0 && Number.isFinite(a.volatility) && a.volatility >= 0 && a.volatility <= 5 && Number.isFinite(a.dividend) && a.dividend >= 0 && a.dividend <= 1;
}

export function scenarioPnl(leg: RiskLeg, assumption: Assumption, shock: number, horizon: number, rate: number, terminal: boolean) {
  const spot = assumption.spot * (1 + shock / 100);
  const value = leg.position.sec_type === "STK" ? spot : optionValue(spot, leg.strike, leg.position.right, terminal ? 0 : Math.max(0, leg.days - horizon) / 365, assumption.volatility, rate, assumption.dividend);
  // IBKR derivative average cost already includes the contract multiplier.
  const raw = leg.quantity * (value * leg.multiplier - leg.cost);
  if (terminal) return raw;

  // Anchor today's estimated curve to the broker's live marked P&L. A pure
  // Black–Scholes value with one desk-wide volatility can be far away from the
  // option's actual market mark, making the 0% metric look stale while IB P&L
  // is moving. The correction decays to zero by expiry, where intrinsic payoff
  // (and therefore the terminal curve) must remain authoritative.
  const marked = numeric(leg.position.unrealized_pnl) ?? (() => {
    const price = numeric(leg.position.market_price);
    return price === null ? null : leg.quantity * (price * leg.multiplier - leg.cost);
  })();
  if (marked === null) return raw;
  const anchorSpot = leg.position.sec_type === "STK"
    ? numeric(leg.position.market_price) ?? assumption.spot
    : numeric(leg.position.underlying_price) ?? assumption.spot;
  const anchorValue = leg.position.sec_type === "STK"
    ? anchorSpot
    : optionValue(anchorSpot, leg.strike, leg.position.right, leg.days / 365, assumption.volatility, rate, assumption.dividend);
  const rawAtAnchor = leg.quantity * (anchorValue * leg.multiplier - leg.cost);
  const remaining = leg.position.sec_type === "OPT"
    ? (leg.days > 0 ? Math.max(0, leg.days - horizon) / leg.days : 0)
    : 1;
  return raw + (marked - rawAtAnchor) * remaining;
}

export function buildCurves(legs: RiskLeg[], assumptions: Record<string, Assumption>, range: number, horizon: number, rate: number) {
  const shocks = new Set(Array.from({ length: 81 }, (_, i) => -Math.min(range, 100) + (Math.min(range, 100) + range) * i / 80));
  shocks.add(0);
  // These exact points drive the RMS table even when the chart's evenly spaced
  // samples would otherwise fall between whole percentage levels.
  for (const shock of RMS_SHOCKS) {
    if (shock >= -Math.min(range, 100) && shock <= range) shocks.add(shock);
  }
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
