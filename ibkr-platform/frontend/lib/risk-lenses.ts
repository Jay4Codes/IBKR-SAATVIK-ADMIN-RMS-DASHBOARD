import { Assumption, brokerSpot, buildCurves, expiryDate, numeric, RiskLeg, underlyingKey, validAssumption } from "./payoff";
import { Position, RealizedSummary } from "./types";
import { todayIn } from "./timezone";

export type Lens = "asset" | "expiry" | "account";
export const LENSES: { id: Lens; label: string; noun: string }[] = [
  { id: "asset", label: "By asset", noun: "underlying" },
  { id: "expiry", label: "By expiry", noun: "expiry" },
  { id: "account", label: "By account", noun: "account" },
];

export type ShockMode = "parallel" | "beta";

export const NO_EXPIRY = "STK";
export const expiryOf = (p: Position) => p.expiry || NO_EXPIRY;

export type Bucket = "Today" | "Tomorrow" | "This week" | "Later" | "No expiry";
export const BUCKET_ORDER: Bucket[] = ["Today", "Tomorrow", "This week", "Later", "No expiry"];

const DAY = 86400000;

/** Buckets an expiry against the exchange calendar, not the browser's. */
export function expiryBucket(expiry: string, now: number): Bucket {
  if (expiry === NO_EXPIRY) return "No expiry";
  const date = expiryDate(expiry);
  if (!date) return "Later";
  const today = todayIn("ET", now);
  if (date === today) return "Today";
  const days = Math.round((Date.parse(date) - Date.parse(today)) / DAY);
  if (days === 1) return "Tomorrow";
  if (days > 1 && days <= 7) return "This week";
  return days < 0 ? "Today" : "Later";
}

export function expiryLabel(expiry: string): string {
  if (expiry === NO_EXPIRY) return "Stock, no expiry";
  return expiryDate(expiry) || expiry;
}

export function groupKey(lens: Lens, leg: RiskLeg): string {
  if (lens === "asset") return underlyingKey(leg.position);
  if (lens === "expiry") return expiryOf(leg.position);
  return leg.position.account_id;
}

export function groupLabel(lens: Lens, id: string): string {
  if (lens === "asset") return id.split(":").at(-1) ?? id;
  if (lens === "expiry") return expiryLabel(id);
  return id;
}

export type LensRow = {
  id: string;
  label: string;
  legs: RiskLeg[];
  keys: string[];
  accounts: string[];
  expiries: string[];
  bucket?: Bucket;
  reference?: { price: number; source: string };
  /** Marked P&L at the current reference, adjusted for booked legs. */
  now: number;
  /** Terminal P&L at each requested level, adjusted. */
  at: Record<number, number>;
  /** Pre-expiry estimate at each requested level, adjusted. */
  estimate: Record<number, number>;
  /** Worst terminal value across the whole plotted range, adjusted. */
  worst: number;
  /** Terminal curve sampled across the range for the inline sparkline. */
  spark: number[];
  /** Booked P&L and added-back commissions attributed to this row. */
  adjustment: number;
  /** Sum of net liquidation for the accounts in this row, if known. */
  nlv: number | null;
};

export function unpricedPositions(rows: Position[], currency: string, assumptions: Record<string, Assumption>) {
  const out: { key: string; positions: Position[]; marketValue: number }[] = [];
  const seen = new Map<string, Position[]>();
  for (const p of rows) {
    if ((p.currency || "Unknown") !== currency || numeric(p.quantity) === 0) continue;
    if (!["STK", "OPT"].includes(p.sec_type)) continue;
    const key = underlyingKey(p);
    if (validAssumption(assumptions[key])) continue;
    (seen.get(key) ?? seen.set(key, []).get(key)!).push(p);
  }
  for (const [key, positions] of seen) {
    out.push({
      key,
      positions,
      marketValue: positions.reduce((sum, p) => sum + (numeric(p.market_value) ?? 0), 0),
    });
  }
  return out.sort((a, b) => Math.abs(b.marketValue) - Math.abs(a.marketValue));
}

export type RealizedLeg = RealizedSummary["legs"][number];

export function legAdjustment(leg: RealizedLeg, withClosed: boolean, withCommissions: boolean): number {
  const realized = numeric(leg.realized_pnl) ?? 0;
  const commission = numeric(leg.commission) ?? 0;
  return (withClosed ? realized : 0) + (!withCommissions && realized === 0 ? commission : 0);
}

export function realizedGroupKey(lens: Lens, leg: RealizedLeg): string {
  if (lens === "asset") return `${leg.currency ?? "Unknown"}:${leg.underlying ?? leg.symbol ?? ""}`;
  if (lens === "expiry") return leg.expiry || NO_EXPIRY;
  return leg.account_id;
}

export function realizedByGroup(lens: Lens, legs: RealizedLeg[], withClosed: boolean, withCommissions: boolean) {
  const out: Record<string, number> = {};
  for (const leg of legs) {
    const amount = legAdjustment(leg, withClosed, withCommissions);
    if (!amount) continue;
    const key = realizedGroupKey(lens, leg);
    out[key] = (out[key] ?? 0) + amount;
  }
  return out;
}

export function buildRows(
  lens: Lens,
  legs: RiskLeg[],
  assumptions: Record<string, Assumption>,
  options: {
    range: number;
    horizon: number;
    rate: number;
    levels: readonly number[];
    now: number;
    adjustments?: Record<string, number>;
    nlv?: Record<string, number | null>;
  },
): LensRow[] {
  const groups = new Map<string, RiskLeg[]>();
  for (const leg of legs) {
    const id = groupKey(lens, leg);
    (groups.get(id) ?? groups.set(id, []).get(id)!).push(leg);
  }
  const rows: LensRow[] = [];
  for (const [id, group] of groups) {
    const points = buildCurves(group, assumptions, options.range, options.horizon, options.rate, options.levels);
    if (!points.length) continue;
    const adjustment = options.adjustments?.[id] ?? 0;
    const zero = points.find(p => p.shock === 0) ?? points[0];
    const at: Record<number, number> = {};
    const estimate: Record<number, number> = {};
    for (const level of options.levels) {
      const point = points.find(p => Math.abs(p.shock - level) < 1e-9);
      if (point) {
        at[level] = point.terminal + adjustment;
        estimate[level] = point.modeled + adjustment;
      }
    }
    const keys = [...new Set(group.map(leg => underlyingKey(leg.position)))].sort();
    const accounts = [...new Set(group.map(leg => leg.position.account_id))].sort();
    const nlvs = accounts.map(account => options.nlv?.[account] ?? null);
    const nlv = nlvs.length && nlvs.every(v => v !== null && v > 0) ? nlvs.reduce<number>((s, v) => s + (v ?? 0), 0) : null;
    rows.push({
      id,
      label: groupLabel(lens, id),
      legs: group,
      keys,
      accounts,
      expiries: [...new Set(group.map(leg => expiryOf(leg.position)))].sort(),
      bucket: lens === "expiry" ? expiryBucket(id, options.now) : undefined,
      reference: keys.length === 1 ? brokerSpot(group, keys[0]) : undefined,
      now: zero.modeled + adjustment,
      at,
      estimate,
      worst: Math.min(...points.map(p => p.terminal)) + adjustment,
      spark: points.map(p => p.terminal + adjustment),
      adjustment,
      nlv,
    });
  }
  return sortRows(lens, rows);
}

function sortRows(lens: Lens, rows: LensRow[]): LensRow[] {
  if (lens === "expiry") return rows.sort((a, b) => (a.id === NO_EXPIRY ? 1 : b.id === NO_EXPIRY ? -1 : a.id.localeCompare(b.id)));
  return rows.sort((a, b) => a.worst - b.worst || a.label.localeCompare(b.label));
}

/** The underlying carrying the most risk — where the drill-down chart should open. */
export function dominantKey(rows: LensRow[]): string | undefined {
  const byKey = new Map<string, number>();
  for (const row of rows) for (const key of row.keys) byKey.set(key, Math.min(byKey.get(key) ?? 0, row.worst));
  return [...byKey.entries()].sort((a, b) => a[1] - b[1])[0]?.[0];
}

export function percentOf(value: number, nlv: number | null): number | null {
  return nlv && nlv > 0 ? (value / nlv) * 100 : null;
}

/** Threshold shading for a loss as a share of the account's liquidation value. */
export function breachClass(percent: number | null, warn = -5, breach = -10): "" | "warn" | "breach" {
  if (percent === null) return "";
  if (percent <= breach) return "breach";
  if (percent <= warn) return "warn";
  return "";
}
