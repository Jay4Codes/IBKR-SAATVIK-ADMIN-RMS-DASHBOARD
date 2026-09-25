"use client";
import { useEffect, useRef, useState } from "react";
import { Account, Position } from "@/lib/types";
import { money } from "./tables";
import { accountDisplay } from "./account-names";

type Row = { label: string; value: number | null; color?: string };

function useNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 640px)");
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return narrow;
}

function Bars({ rows, name, ariaLabel, light }: { rows: Row[]; name: string; ariaLabel: string; light: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const narrow = useNarrow();
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void Promise.all([
      import("echarts/core"),
      import("echarts/charts"),
      import("echarts/components"),
      import("echarts/renderers"),
    ])
      .then(([echarts, charts, components, renderers]) => {
        if (cancelled || !ref.current) return;
        echarts.use([charts.BarChart, components.GridComponent, components.TooltipComponent, renderers.SVGRenderer]);
        const styles = getComputedStyle(ref.current);
        const muted = styles.getPropertyValue("--muted").trim();
        const accent = styles.getPropertyValue("--accent").trim();
        const grid = styles.getPropertyValue("--grid").trim();
        const line = styles.getPropertyValue("--line-strong").trim();
        const chart = echarts.init(ref.current, undefined, { renderer: "svg" });
        chart.setOption({
          animation: false,
          grid: { top: 8, bottom: 22, left: 4, right: narrow ? 8 : 20, containLabel: true },
          tooltip: {
            trigger: "axis",
            axisPointer: { type: "shadow" },
            confine: true,
            textStyle: { fontSize: 11 },
            valueFormatter: (v: number | null) => (v == null ? "—" : money(String(v))),
          },
          xAxis: {
            type: "value",
            axisLabel: { color: muted, fontSize: narrow ? 8 : 9, hideOverlap: true },
            splitLine: { lineStyle: { color: grid } },
          },
          yAxis: {
            type: "category",
            inverse: true,
            data: rows.map((r) => r.label),
            axisLabel: { color: muted, fontSize: narrow ? 9 : 10, interval: 0 },
            axisTick: { show: false },
            axisLine: { show: false },
          },
          series: [
            {
              name,
              type: "bar",
              data: rows.map((r) => ({ value: r.value, itemStyle: { color: r.color ?? accent } })),
              barMaxWidth: 12,
              markLine: rows.some((r) => (r.value ?? 0) < 0)
                ? { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: line, width: 1 }, data: [{ xAxis: 0 }] }
                : undefined,
            },
          ],
        });
        const observer = new ResizeObserver(() => chart.resize());
        observer.observe(ref.current);
        dispose = () => {
          observer.disconnect();
          chart.dispose();
        };
      })
      .catch((error) => console.error("Allocation chart failed", error));
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [rows, name, light, narrow]);
  return (
    <div
      className="chart"
      ref={ref}
      style={{ height: Math.min(320, Math.max(110, rows.length * (narrow ? 30 : 34) + 40)) }}
      role="img"
      aria-label={ariaLabel}
    />
  );
}

const num = (value: string | null | undefined) => (value == null || value === "" ? null : Number(value));

export type AssetBucket = { label: string; value: number; long: number; short: number; count: number; note?: string };

/** One row per asset: each stock or fund by ticker, each option underlying as "<name> options", then cash. */
export function assetBuckets(accounts: Account[], positions: Position[]): { buckets: AssetBucket[]; unpriced: string[]; total: number } {
  const cash = accounts.reduce((sum, a) => sum + (num(a.cash) ?? 0), 0);
  const total = accounts.reduce((sum, a) => sum + (num(a.net_liquidation) ?? 0), 0);
  const byName = new Map<string, AssetBucket>();
  const unpriced: string[] = [];
  for (const p of positions) {
    const quantity = Number(p.quantity || 0);
    if (!quantity) continue;
    const value = num(p.market_value);
    const symbol = (p.symbol || "").toUpperCase();
    if (value == null) {
      unpriced.push(symbol);
      continue;
    }
    const option = p.sec_type === "OPT" || p.sec_type === "FOP";
    const label = option ? `${symbol} options` : symbol;
    const bucket = byName.get(label) ?? {
      label,
      value: 0,
      long: 0,
      short: 0,
      count: 0,
      note: option ? "Long legs less short legs, at market" : p.sec_type === "STK" ? "Shares at market" : p.sec_type,
    };
    bucket.value += value;
    bucket.count += 1;
    if (quantity > 0) bucket.long += value;
    else bucket.short += value;
    byName.set(label, bucket);
  }
  const assets = [...byName.values()].sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const cashBucket: AssetBucket = { label: "Cash", value: cash, long: cash, short: 0, count: accounts.length, note: "Net of margin loans" };
  return { buckets: [...assets, cashBucket], unpriced: [...new Set(unpriced)].sort(), total };
}

export function AllocationChart({
  accounts,
  positions,
  positionsLoading = false,
  light,
}: {
  accounts: Account[];
  positions: Position[];
  positionsLoading?: boolean;
  light: boolean;
}) {
  const accountRows: Row[] = accounts.map((a) => ({ label: accountDisplay(a), value: num(a.net_liquidation) }));
  const { buckets, unpriced, total } = assetBuckets(accounts, positions);
  const assetRows: Row[] = buckets.map((b) => ({ label: b.label, value: b.value, color: b.value < 0 ? "var(--red)" : undefined }));
  const share = (value: number) => (total ? `${((value / total) * 100).toFixed(1)}%` : "—");
  return (
    <div className="allocation-split">
      <div>
        <h3 className="allocation-title">By account<small>Net liquidation</small></h3>
        <Bars rows={accountRows} name="Net liquidation" ariaLabel="Net liquidation by account" light={light} />
        <div className="allocation">
          {accounts.map((a) => (
            <div key={a.account_id}>
              <span>{accountDisplay(a)}</span>
              <b>{money(a.net_liquidation)}</b>
            </div>
          ))}
        </div>
      </div>
      <div>
        <h3 className="allocation-title">By asset<small>Market value by name · share of net liquidation</small></h3>
        {positionsLoading ? (
          <p className="footnote" role="status">Loading positions…</p>
        ) : (
          <>
            <Bars rows={assetRows} name="Market value" ariaLabel="Market value by asset class" light={light} />
            <div className="allocation assets">
              {buckets.map((b) => (
                <div key={b.label} title={b.note}>
                  <span>
                    {b.label}
                    {b.label !== "Cash" && b.short < 0 && (
                      <small> long {money(String(b.long))} · short {money(String(b.short))}</small>
                    )}
                    {b.label !== "Cash" && b.short >= 0 && b.count > 0 && (
                      <small> {b.count} position{b.count === 1 ? "" : "s"}</small>
                    )}
                    {b.label === "Cash" && <small> {b.note}</small>}
                  </span>
                  <b>
                    {money(String(b.value))}
                    <small> {share(b.value)}</small>
                  </b>
                </div>
              ))}
            </div>
            {unpriced.length > 0 && (
              <p className="footnote">
                Not valued, so not counted above: {unpriced.join(", ")}. The broker sends no price
                for these without a market-data subscription.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
