import { describe, expect, it } from "vitest";
import { buildCurves, prepareLegs, RMS_SHOCKS, signedLevels } from "@/lib/payoff";
import { parseLevels } from "@/lib/persisted";
import { Position } from "@/lib/types";

describe("custom scenario levels", () => {
  it("turns a magnitude into the pair of columns a desk means by it", () => {
    // "What about seven percent" is two questions, not one.
    expect(signedLevels([7])).toEqual([-7, 7]);
    expect(signedLevels([1, 3])).toEqual([-3, -1, 1, 3]);
    // A sign on the way in makes no difference to the pair that comes out.
    expect(signedLevels([-7])).toEqual([-7, 7]);
  });

  it("keeps the levels ordered and free of duplicates", () => {
    const levels = signedLevels([...RMS_SHOCKS, 7, 7, 3]);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
    expect(new Set(levels).size).toBe(levels.length);
    expect(levels).toContain(7);
    expect(levels).toContain(-7);
  });

  it("ignores nonsense rather than making a column out of it", () => {
    expect(signedLevels([0, NaN, Infinity])).toEqual([]);
    expect(parseLevels("7, 12.5, , abc, 0, -3, 1000")).toEqual([3, 7, 12.5]);
    // Rounded to a tenth: nobody wants a column headed +7.3333%.
    expect(parseLevels("7.3333")).toEqual([7.3]);
    expect(parseLevels("")).toEqual([]);
  });

  it("samples a custom level exactly, even outside the plotted range", () => {
    const position = (fields: Partial<Position> = {}): Position => ({
      account_id: "A", con_id: 1, symbol: "XYZ", local_symbol: "", sec_type: "STK",
      currency: "USD", expiry: "", strike: "", right: "", multiplier: "1",
      quantity: "1", average_cost: "100", market_price: "100", market_value: "100",
      unrealized_pnl: "0", underlying_price: "100", ...fields,
    } as Position);
    const { legs } = prepareLegs([position()], Date.parse("2026-09-21T14:00:00Z"));
    const assumptions = { "USD:XYZ": { spot: 100, volatility: 0.2, dividend: 0 } };
    // A ±25% level asked for while the chart is showing ±10%.
    const levels = signedLevels([...RMS_SHOCKS, 25]);
    const points = buildCurves(legs, assumptions, 10, 0, 0, levels);
    const shocks = points.map(p => p.shock);
    for (const level of levels) expect(shocks).toContain(level);
    // Answering "that is off the chart" would be worse than the figure asked for.
    expect(shocks).toContain(25);
    expect(shocks).toContain(-25);
  });
});

describe("column headings", () => {
  it("shows a fractional level as the level that was asked for", async () => {
    const { levelLabel } = await import("@/components/payoff-panel");
    expect(levelLabel(7)).toBe("+7%");
    expect(levelLabel(-7)).toBe("-7%");
    // Rounding this to 13% would answer a question nobody asked.
    expect(levelLabel(12.5)).toBe("+12.5%");
    expect(levelLabel(-12.5)).toBe("-12.5%");
  });
});

describe("scenario columns", () => {
  it("makes one column from a price and two from a percentage", async () => {
    const { buildColumns } = await import("@/components/payoff-panel");
    const columns = buildColumns([3], [7800], 7600);
    // Ordered by where each sits, not grouped by kind: 7,800 on a 7,600
    // reference is +2.63%, which belongs between the −3% and +3% columns.
    expect(columns.map(c => c.kind)).toEqual(["pct", "price", "pct"]);
    expect(columns.map(c => c.label)).toEqual(["-3%", "7,800", "+3%"]);
    // The price keeps its own heading rather than being restated as a move.
    const price = columns.find(c => c.kind === "price")!;
    expect(price.label).toBe("7,800");
    expect(price.shock).toBeCloseTo((7800 / 7600 - 1) * 100, 6);
  });

  it("orders every column by where it sits, whatever kind it is", async () => {
    const { buildColumns } = await import("@/components/payoff-panel");
    const columns = buildColumns([5], [7000, 7800], 7600);
    expect(columns.map(c => c.shock)).toEqual([...columns.map(c => c.shock)].sort((a, b) => a - b));
    expect(columns[0].label).toBe("7,000");
  });

  it("lets a price take over a column a percentage already held", async () => {
    const { buildColumns } = await import("@/components/payoff-panel");
    // 7,600 at a 7,600 reference is the 0% column; the reader asked in prices.
    const columns = buildColumns([3], [7600], 7600);
    const zero = columns.filter(c => Math.abs(c.shock) < 1e-9);
    expect(zero).toHaveLength(1);
    expect(zero[0].kind).toBe("price");
  });

  it("has nothing to show when every level has been removed", async () => {
    const { buildColumns } = await import("@/components/payoff-panel");
    expect(buildColumns([], [], 7600)).toEqual([]);
  });

  it("skips price columns when there is no reference to convert them at", async () => {
    const { buildColumns } = await import("@/components/payoff-panel");
    expect(buildColumns([1], [7800], 0).every(c => c.kind === "pct")).toBe(true);
  });

  it("reads prices back out of storage, ignoring what is not one", async () => {
    const { parsePrices } = await import("@/lib/persisted");
    expect(parsePrices("7800, 7000.5, , abc, -5, 0")).toEqual([7000.5, 7800]);
    expect(parsePrices("")).toEqual([]);
  });
});

describe("telling default columns from added ones", () => {
  it("marks only the levels the reader added", async () => {
    const { buildColumns } = await import("@/components/payoff-panel");
    const columns = buildColumns([1, 3, 5, 10, 7], [7600], 7600);
    const byLabel = Object.fromEntries(columns.map(c => [c.label, c]));
    // Shipped defaults are not the reader's to have added.
    expect(byLabel["+3%"].custom).toBe(false);
    expect(byLabel["-10%"].custom).toBe(false);
    // Theirs, and marked as such in both directions.
    expect(byLabel["+7%"].custom).toBe(true);
    expect(byLabel["-7%"].custom).toBe(true);
    // A price is always theirs — nothing ships one.
    expect(byLabel["7,600"].custom).toBe(true);
  });
});

describe("column identity on every cell", () => {
  it("names the kind on each cell, not only on the heading", async () => {
    const { buildColumns } = await import("@/components/payoff-panel");
    // A column has to be styleable top to bottom, so the class has to be
    // available to every cell — the heading alone cannot draw a full-height rule.
    const columns = buildColumns([3, 7], [7600], 7600);
    const custom = columns.filter(c => c.custom).map(c => c.label).sort();
    expect(custom).toEqual(["+7%", "-7%", "7,600"].sort());
    expect(columns.filter(c => !c.custom).map(c => c.label).sort()).toEqual(["+3%", "-3%"]);
  });
});

describe("moving column order", () => {
  it("keeps the default order when nothing has been moved", async () => {
    const { buildColumns, orderColumns } = await import("@/components/payoff-panel");
    const columns = buildColumns([1, 3], [], 7600);
    expect(orderColumns(columns, [])).toEqual(columns);
  });

  it("puts moved columns where the reader left them", async () => {
    const { buildColumns, orderColumns } = await import("@/components/payoff-panel");
    const columns = buildColumns([1, 3], [], 7600);
    const ids = columns.map(c => c.id);
    // Swap the first two.
    const swapped = [ids[1], ids[0], ...ids.slice(2)];
    const ordered = orderColumns(columns, swapped);
    expect(ordered.map(c => c.id)).toEqual(swapped);
  });

  it("appends a newly added level after the reader's own order, not into its middle", async () => {
    const { buildColumns, orderColumns } = await import("@/components/payoff-panel");
    // Reader reversed a two-level grid (-3%, -1%, +1%, +3%)…
    const before = buildColumns([1, 3], [], 7600);
    const storedOrder = before.map(c => c.id).reverse();
    // …then added ±5%, which was not part of that stored order.
    const withNew = buildColumns([1, 3, 5], [], 7600);
    const ordered = orderColumns(withNew, storedOrder);
    // The four known ids keep the reversed order exactly, untouched…
    expect(ordered.slice(0, 4).map(c => c.id)).toEqual(storedOrder);
    // …and the two new columns land after them, in their own natural order —
    // not threaded into the reversed arrangement, which has no single
    // well-defined "natural place" for something new once it stops being
    // sorted by level.
    expect(ordered.slice(4).map(c => c.id)).toEqual(["pct:-5", "pct:5"]);
  });

  it("appends several new columns among themselves in natural order", async () => {
    const { buildColumns, orderColumns } = await import("@/components/payoff-panel");
    const ordered = orderColumns(buildColumns([1, 3, 5], [], 7600), ["pct:1"]);
    expect(ordered[0].id).toBe("pct:1");
    expect(ordered.slice(1).map(c => c.shock)).toEqual([-5, -3, -1, 3, 5]);
  });

  it("drops a stale id for a column that no longer exists", async () => {
    const { buildColumns, orderColumns } = await import("@/components/payoff-panel");
    const columns = buildColumns([1], [], 7600);
    const ordered = orderColumns(columns, ["pct:-1", "price:9999", "pct:1"]);
    expect(ordered.map(c => c.id)).toEqual(["pct:-1", "pct:1"]);
  });
});
