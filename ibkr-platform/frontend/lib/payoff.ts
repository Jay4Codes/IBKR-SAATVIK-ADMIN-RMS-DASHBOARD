import { Position } from "./types";

export type Assumption = { spot: number; volatility: number; dividend: number };
export type RiskLeg = { position: Position; quantity: number; cost: number; multiplier: number; strike: number; days: number };
export const RMS_SHOCKS = [-10, -5, -3, -1, 1, 3, 5, 10] as const;
export const underlyingKey = (p: Position) => `${p.currency}:${p.symbol}`;
export function numeric(value: string | null | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function brokerSpot(legs: RiskLeg[], key: string): { price: number; source: string } | undefined {
  const stock = legs.find(l => underlyingKey(l.position) === key && l.position.sec_type === "STK" && (numeric(l.position.market_price) ?? 0) > 0);
  if (stock) return { price: numeric(stock.position.market_price)!, source: "ib_stock_mark" };
  const quoted = legs.find(l => underlyingKey(l.position) === key && (numeric(l.position.underlying_price) ?? 0) > 0);
  if (!quoted) return undefined;
  return { price: numeric(quoted.position.underlying_price)!, source: quoted.position.underlying_source || "ib_und_price" };
}

export function previousClose(legs: RiskLeg[], key: string): number | undefined {
  const found = legs.find(l => underlyingKey(l.position) === key && (numeric(l.position.underlying_prev_close) ?? 0) > 0);
  return found ? numeric(found.position.underlying_prev_close)! : undefined;
}

export function spotLabel(source: string): string {
  if (source.endsWith("_cached")) return "Stored last underlying price — not live";
  if (source === "aggs_prev" || source === "stocks_snapshot_prev") return "Massive — previous session close, not a live mark";
  if (source.startsWith("massive_") || ["indices_snapshot", "options_snapshot", "stocks_snapshot"].includes(source)) return "Massive live snapshot";
  if (source === "ib_stock_mark") return "Live broker mark — held stock";
  return "Live broker mark";
}

export function expiryDate(expiry: string): string {
  const date = /^\d{8}$/.test(expiry) ? `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6)}` : "";
  if (!date) return "";
  const timestamp = Date.parse(date);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date ? date : "";
}

const EXCHANGE_ZONE = "America/New_York";
const EXPIRY_CLOSE_HOUR = 16;

function zoneOffset(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const at = Object.fromEntries(parts.map(p => [p.type, p.value])) as Record<string, string>;
  const asUtc = Date.UTC(+at.year, +at.month - 1, +at.day, +at.hour % 24, +at.minute, +at.second);
  return asUtc - instant;
}

export function expiryInstant(expiry: string): number {
  const date = expiryDate(expiry);
  if (!date) return NaN;
  const naive = Date.parse(`${date}T${String(EXPIRY_CLOSE_HOUR).padStart(2, "0")}:00:00Z`);
  if (!Number.isFinite(naive)) return NaN;
  const once = naive - zoneOffset(naive, EXCHANGE_ZONE);
  return naive - zoneOffset(once, EXCHANGE_ZONE);
}

export function daysToExpiry(expiry: string, at: number): number {
  const instant = expiryInstant(expiry);
  return Number.isFinite(instant) ? (instant - at) / 86400000 : NaN;
}

export function prepareLegs(positions: Position[], at: number) {
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
    const days = daysToExpiry(p.expiry, at);
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

export function normalCdf(x: number) { return cdf(x); }
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

export function skewByExpiry(positions: Position[], at: number, rate: number, dividend: number): Map<string, SkewPoint[]> {
  const groups = new Map<string, SkewPoint[]>();
  for (const p of positions) {
    if (p.sec_type !== "OPT" || !["C", "P"].includes(p.right) || numeric(p.quantity) === 0) continue;
    const date = expiryDate(p.expiry);
    if (!date) continue;
    const days = daysToExpiry(p.expiry, at);
    if (!(days > 0)) continue;
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

export const DEFAULT_RATE = 0.04;
export const DEFAULT_DIV_YIELD = 0.012;
export const ASSUMED_VOL = 0.3;

export function impliedByUnderlying(legs: RiskLeg[], rate: number, dividend: number): Record<string, number> {
  const found: Record<string, number[]> = {};
  for (const leg of legs) {
    const p = leg.position;
    if (p.sec_type !== "OPT" || !["C", "P"].includes(p.right)) continue;
    const price = numeric(p.market_price), spot = numeric(p.underlying_price);
    if (price === null || spot === null || spot <= 0 || leg.strike <= 0 || !(leg.days > 0)) continue;
    const iv = impliedVolatility(price, spot, leg.strike, p.right, leg.days / 365, rate, dividend);
    if (iv === null) continue;
    (found[underlyingKey(p)] ??= []).push(iv);
  }
  const out: Record<string, number> = {};
  for (const [key, values] of Object.entries(found)) {
    const sorted = values.sort((a, b) => a - b), mid = sorted.length >> 1;
    out[key] = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return out;
}

export function validAssumption(a: Assumption | undefined): a is Assumption {
  return !!a && Number.isFinite(a.spot) && a.spot > 0 && Number.isFinite(a.volatility) && a.volatility >= 0 && a.volatility <= 5 && Number.isFinite(a.dividend) && a.dividend >= 0 && a.dividend <= 1;
}

export function scenarioPnl(leg: RiskLeg, assumption: Assumption, shock: number, horizon: number, rate: number, terminal: boolean) {
  const spot = assumption.spot * (1 + shock / 100);
  const value = leg.position.sec_type === "STK" ? spot : optionValue(spot, leg.strike, leg.position.right, terminal ? 0 : Math.max(0, leg.days - horizon) / 365, assumption.volatility, rate, assumption.dividend);
  const raw = leg.quantity * (value * leg.multiplier - leg.cost);
  if (terminal) return raw;

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

export function signedLevels(magnitudes: readonly number[]): number[] {
  const levels = new Set<number>();
  for (const value of magnitudes) {
    if (!Number.isFinite(value) || value === 0) continue;
    levels.add(Math.abs(value));
    levels.add(-Math.abs(value));
  }
  return [...levels].sort((a, b) => a - b);
}

export function buildCurves(
  legs: RiskLeg[], assumptions: Record<string, Assumption>, range: number, horizon: number,
  rate: number, levels: readonly number[] = RMS_SHOCKS,
) {
  const shocks = new Set(Array.from({ length: 81 }, (_, i) => -Math.min(range, 100) + (Math.min(range, 100) + range) * i / 80));
  shocks.add(0);

  for (const shock of levels) {
    if (Number.isFinite(shock) && shock > -100) shocks.add(shock);
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
    const callSlope = calls.reduce((n, q) => n + (calls.length === 1 ? q : Math.min(0, q)), 0);
    return g.shares + callSlope < 0;
  }).map(([key]) => key);
}

export type PricePoint = { price: number; shock: number; terminal: number; modeled: number; accounts: Record<string, number> };

export function buildPriceCurve(
  legs: RiskLeg[], assumptions: Record<string, Assumption>, key: string,
  range: number, horizon: number, rate: number, samples = 240,
): PricePoint[] {
  const spot = assumptions[key]?.spot;
  if (!(spot > 0)) return [];
  const lo = spot * (1 - Math.min(range, 95) / 100), hi = spot * (1 + range / 100);
  const prices = new Set<number>();
  for (let i = 0; i <= samples; i++) prices.add(lo + (hi - lo) * i / samples);
  prices.add(spot);
  for (const leg of legs) {
    if (leg.position.sec_type !== "OPT" || !(leg.strike > 0)) continue;
    if (leg.strike < lo || leg.strike > hi) continue;
    prices.add(leg.strike);
    prices.add(leg.strike * (1 - 1e-6));
    prices.add(leg.strike * (1 + 1e-6));
  }
  return [...prices].sort((a, b) => a - b).map(price => {
    const shock = (price / spot - 1) * 100;
    let terminal = 0, modeled = 0;
    const accounts: Record<string, number> = {};
    for (const leg of legs) {
      const a = assumptions[underlyingKey(leg.position)];
      const pnl = scenarioPnl(leg, a, shock, horizon, rate, true);
      terminal += pnl;
      modeled += scenarioPnl(leg, a, shock, horizon, rate, false);
      accounts[leg.position.account_id] = (accounts[leg.position.account_id] ?? 0) + pnl;
    }
    return { price, shock, terminal, modeled, accounts };
  });
}

export function breakevens(points: PricePoint[], offset = 0): number[] {
  const out: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1].terminal + offset, b = points[i].terminal + offset;
    if (a === 0) out.push(points[i - 1].price);
    else if (a < 0 !== b < 0) {
      const t = a / (a - b);
      out.push(points[i - 1].price + t * (points[i].price - points[i - 1].price));
    }
  }
  return [...new Set(out.map(p => Math.round(p * 100) / 100))];
}

export function priceCdf(price: number, spot: number, volatility: number, years: number, rate: number, dividend: number) {
  if (!(price > 0) || !(spot > 0) || !(years > 0) || !(volatility > 0)) return price >= spot ? 1 : 0;
  const v = volatility * Math.sqrt(years);
  return normalCdf((Math.log(price / spot) - (rate - dividend - volatility * volatility / 2) * years) / v);
}

export function priceDensity(price: number, spot: number, volatility: number, years: number, rate: number, dividend: number) {
  if (!(price > 0) || !(spot > 0) || !(years > 0) || !(volatility > 0)) return 0;
  const v = volatility * Math.sqrt(years);
  const d = (Math.log(price / spot) - (rate - dividend - volatility * volatility / 2) * years) / v;
  return Math.exp(-d * d / 2) / (price * v * Math.sqrt(2 * Math.PI));
}

export type StrategyStats = {
  netCredit: number;
  maxProfit: number; maxLoss: number;
  uncappedUpside: boolean; uncappedDownside: boolean;
  breakevens: number[];
  chanceOfProfit: number | null;
};

export function strategyStats(
  points: PricePoint[], wide: PricePoint[], legs: RiskLeg[], spot: number, volatility: number,
  years: number, rate: number, dividend: number, offset = 0,
): StrategyStats {
  const netCredit = -legs.reduce((sum, leg) => sum + leg.quantity * leg.cost, 0);
  const values = (wide.length ? wide : points).map(p => p.terminal + offset);
  const edge = (a: PricePoint | undefined, b: PricePoint | undefined) =>
    a && b ? b.terminal - a.terminal : 0;
  const rising = edge(wide.at(-2), wide.at(-1));
  const falling = edge(wide[1], wide[0]);
  const tolerance = Math.max(1, Math.abs(netCredit) * 1e-6);
  const crossings = breakevens(points, offset);
  let chance: number | null = null;
  if (points.length > 1 && spot > 0 && years > 0 && volatility > 0) {
    chance = 0;
    for (let i = 1; i < points.length; i++) {
      const mid = (points[i - 1].terminal + points[i].terminal) / 2 + offset;
      if (mid <= 0) continue;
      chance += priceCdf(points[i].price, spot, volatility, years, rate, dividend)
        - priceCdf(points[i - 1].price, spot, volatility, years, rate, dividend);
    }
    chance = Math.min(1, Math.max(0, chance));
  }
  return {
    netCredit,
    maxProfit: values.length ? Math.max(...values) : 0,
    maxLoss: values.length ? Math.min(...values) : 0,
    uncappedUpside: rising > tolerance,
    uncappedDownside: falling > tolerance,
    breakevens: crossings,
    chanceOfProfit: chance,
  };
}
