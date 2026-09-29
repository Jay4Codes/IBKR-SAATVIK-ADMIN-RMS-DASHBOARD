import { Execution } from "./types";

export type Fill = {
  key: string;
  lead: Execution;
  legs: Execution[];
  combo: boolean;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const OCC = /^(\S+)\s+(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

const orderKey = (row: Execution) =>
  `${row.account_id}:${row.execution_id.split(".").slice(0, 2).join(".")}`;

export function groupFills(rows: Execution[]): Fill[] {
  const byOrder = new Map<string, Execution[]>();
  for (const row of rows) {
    const key = orderKey(row);
    const group = byOrder.get(key);
    if (group) group.push(row);
    else byOrder.set(key, [row]);
  }
  const fills: Fill[] = [];
  for (const [key, group] of byOrder) {
    const parent = group.find((row) => row.sec_type === "BAG");
    if (parent) {
      const legs = group
        .filter((row) => row !== parent)
        .sort((a, b) => a.execution_id.localeCompare(b.execution_id));
      fills.push({ key, lead: parent, legs, combo: true });
    } else {
      for (const row of group)
        fills.push({ key: `${row.account_id}:${row.execution_id}`, lead: row, legs: [], combo: false });
    }
  }
  return fills;
}

export const isBuy = (row: Execution) => row.side === "BOT" || row.side === "BUY";

export function expired(fill: Fill): boolean {
  const row = fill.lead;
  if (fill.combo || row.sec_type !== "OPT" || Number(row.price) !== 0 || !row.expiry) return false;
  return row.executed_at.slice(0, 10).replaceAll("-", "") >= row.expiry;
}

function rowExpiry(row: Execution): string | null {
  if (row.expiry && /^\d{8}$/.test(row.expiry)) return row.expiry;
  const occ = OCC.exec(row.symbol);
  return occ ? `20${occ[2]}${occ[3]}${occ[4]}` : null;
}

export function fillExpiry(fill: Fill): string | null {
  const dates = [fill.lead, ...fill.legs].map(rowExpiry).filter((d): d is string => !!d);
  return dates.length ? dates.sort().at(-1)! : null;
}

export function pastExpiry(fill: Fill, now: number = Date.now()): boolean {
  const expiry = fillExpiry(fill);
  if (!expiry) return false;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
    }).formatToParts(now).map(p => [p.type, p.value]),
  );
  const today = `${parts.year}${parts.month}${parts.day}`;
  return expiry < today || (expiry === today && Number(parts.hour) >= 16);
}

export function quantity(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : value;
}

export function expiryShort(value: string | null | undefined): string {
  if (!value || !/^\d{8}$/.test(value)) return value ?? "";
  return `${Number(value.slice(6))} ${MONTHS[Number(value.slice(4, 6)) - 1]}`;
}

export function contract(row: Execution): { name: string; detail: string } {
  const occ = OCC.exec(row.symbol);
  if (occ) {
    const [, root, yy, mm, dd, right, strike] = occ;
    const expiry = row.expiry || `20${yy}${mm}${dd}`;
    return {
      name: `${root} ${(Number(strike) / 1000).toLocaleString()} ${right}`,
      detail: expiryShort(expiry),
    };
  }
  if (row.sec_type === "BAG") return { name: `${row.underlying || "Combo"} combo`, detail: "" };
  return { name: row.symbol, detail: row.sec_type && row.sec_type !== "STK" ? row.sec_type : "" };
}

const multiplier = (row: Execution) => {
  const m = Number(row.multiplier);
  return Number.isFinite(m) && m > 0 ? m : 1;
};

function cash(row: Execution): number | null {
  const price = Number(row.price), qty = Number(row.quantity);
  if (!Number.isFinite(price) || !Number.isFinite(qty)) return null;
  return (isBuy(row) ? -1 : 1) * price * qty * multiplier(row);
}

const sum = (values: (number | null)[]) =>
  values.some((v) => v === null) ? null : values.reduce<number>((a, v) => a + (v ?? 0), 0);

const parts = (fill: Fill) => (fill.combo && fill.legs.length ? fill.legs : [fill.lead]);

export const cashFlow = (fill: Fill) => sum(parts(fill).map(cash));

export const commission = (fill: Fill) =>
  expired(fill) ? 0 : sum(parts(fill).map((row) => (row.commission == null ? null : Math.abs(Number(row.commission)))));

export function realized(fill: Fill): number | null {
  const values = parts(fill)
    .map((row) => (row.realized_pnl == null ? null : Number(row.realized_pnl)))
    .filter((v): v is number => v !== null && Number.isFinite(v) && Math.abs(v) < 1e300);
  return values.length ? values.reduce((a, v) => a + v, 0) : null;
}

export function netRate(fill: Fill): number | null {
  const paid = commission(fill);
  const price = Number(fill.lead.price);
  const units = Number(fill.lead.quantity) * (fill.combo ? multiplier(fill.legs[0] ?? fill.lead) : multiplier(fill.lead));
  if (paid === null || !Number.isFinite(price) || !units) return null;
  const perUnit = paid / Math.abs(units);
  return price + (isBuy(fill.lead) ? perUnit : -perUnit);
}

export function instrument(fill: Fill): string {
  if (fill.combo) return "Combo";
  if (expired(fill)) return "Expiry";
  const type = fill.lead.sec_type;
  return type === "OPT" ? "Option" : type === "STK" ? "Stock" : type === "FUT" ? "Future" : type || "Other";
}
