import { RMS_SHOCKS, signedLevels } from "./payoff";
import { PriceLevel } from "./persisted";

export function levelLabel(shock: number): string {
  const shown = Number.isInteger(shock) ? String(shock) : shock.toFixed(1);
  return `${shock > 0 ? "+" : ""}${shown}%`;
}

export const CUSTOM_LEVELS_KEY = "rms.levels.custom";
export const PRICE_LEVELS_KEY = "rms.levels.price";
export const COLUMN_ORDER_KEY = "rms.columns.order";
export const DEFAULT_LEVELS = RMS_SHOCKS.filter(shock => shock > 0).join(",");
export const MAX_CUSTOM = 8;

export type Column = {
  shock: number;
  label: string;
  kind: "pct" | "price";
  id: string;
  group: string;
  custom: boolean;
};

export const round = (value: number) => Math.round(value * 1e6) / 1e6;

const formatPrice = (price: number) => Math.round(price).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * A price level is quoted in one underlying's own price and anchored on that underlying's spot;
 * every other underlying in the table gets the equivalent percent shock. Levels saved without a
 * symbol are anchored on `benchmark`, the underlying carrying most of the book.
 */
export function buildColumns(
  percents: number[],
  prices: PriceLevel[],
  spotOf: (symbol: string) => number,
  benchmark = "",
): Column[] {
  const columns = new Map<number, Column>();
  for (const shock of signedLevels(percents)) {
    columns.set(round(shock), {
      shock, label: levelLabel(shock), kind: "pct",
      id: `pct:${shock}`, group: `pct:${Math.abs(shock)}`,
      custom: !RMS_SHOCKS.includes(Math.abs(shock) as (typeof RMS_SHOCKS)[number]),
    });
  }
  for (const level of prices) {
    const symbol = level.symbol || benchmark;
    const spot = spotOf(symbol);
    if (!(spot > 0)) continue;
    const shock = round((level.price / spot - 1) * 100);
    const key = `${level.symbol}@${level.price}`;
    columns.set(shock, {
      shock, label: symbol ? `${symbol} ${formatPrice(level.price)}` : formatPrice(level.price), kind: "price",
      id: `price:${key}`, group: `price:${key}`, custom: true,
    });
  }
  return [...columns.values()].sort((a, b) => a.shock - b.shock);
}

export function orderColumns(columns: Column[], order: string[]): Column[] {
  const known = new Map(columns.map(column => [column.id, column]));
  const placed = new Set<string>();
  const ordered: Column[] = [];
  for (const id of order) {
    const column = known.get(id);
    if (column && !placed.has(id)) {
      ordered.push(column);
      placed.add(id);
    }
  }
  for (const column of columns) {
    if (!placed.has(column.id)) ordered.push(column);
  }
  return ordered;
}

const DEFAULT_PCTS = new Set<number>(RMS_SHOCKS.filter(shock => shock > 0));
export const isDefaultPct = (column: Column) =>
  column.kind === "pct" && DEFAULT_PCTS.has(Math.abs(column.shock));

export const cellClass = (column: Column) =>
  `col ${column.kind}${column.custom ? " custom" : ""}`;
