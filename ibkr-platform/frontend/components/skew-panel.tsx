"use client";

import { useEffect, useState } from "react";
import { Position } from "@/lib/types";
import { daysToExpiry, DEFAULT_DIV_YIELD, DEFAULT_RATE, interpolateIv, skewByExpiry, skewCurve, SkewPoint, skewSpot } from "@/lib/payoff";
import { Chart } from "./chart";
import { ChartSkeleton } from "./skeleton";

const SYMBOL = "SPX";
const PALETTE = ["#6f8cff", "#b8d84a", "#f0a43c", "#e06fd0", "#4fc6cf", "#f07f7f"];
const MAX_SELECTED = PALETTE.length;

type Axis = "strike" | "moneyness";
type Series = { expiry: string; color: string; days: number; spot: number; curve: SkewPoint[]; itm: SkewPoint[] };

const pct = (v: number, digits = 1) => `${v.toFixed(digits)}%`;
const toExpiryKey = (date: string) => date.replaceAll("-", "");

export function SkewPanel({ rows, loading, error }: { rows: Position[]; loading: boolean; error: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const [rate, setRate] = useState(DEFAULT_RATE * 100);
  const [dividend, setDividend] = useState(DEFAULT_DIV_YIELD * 100);
  const [axis, setAxis] = useState<Axis>("strike");
  const [showItm, setShowItm] = useState(false);
  const [picked, setPicked] = useState<string[] | null>(null);

  const spx = rows.filter(p => p.symbol.toUpperCase() === SYMBOL && p.sec_type === "OPT");
  const groups = skewByExpiry(spx, now, rate / 100, dividend / 100);
  const available = [...groups.keys()].sort();
  const selected = (picked ?? available.slice(0, 2)).filter(e => available.includes(e));

  const series: Series[] = selected.map(expiry => {
    const points = groups.get(expiry) ?? [];
    const spot = skewSpot(points) ?? 0;
    return {
      expiry,
      color: PALETTE[available.indexOf(expiry) % PALETTE.length],
      days: daysToExpiry(toExpiryKey(expiry), now),
      spot,
      ...skewCurve(points, spot),
    };
  });
  const spot = skewSpot(series.flatMap(s => s.curve));

  const toggle = (expiry: string) => {
    const next = selected.includes(expiry) ? selected.filter(e => e !== expiry) : [...selected, expiry].slice(-MAX_SELECTED);
    setPicked(next.sort());
  };

  return (
    <section className="panel skew-panel">
      <h2>SPX skew — the desk&rsquo;s own book</h2>
      <p className="footnote">
        Implied volatility by strike, backed out of each held contract&rsquo;s broker mark — not a
        market-wide chain. The line follows out-of-the-money options (puts below spot, calls above);
        duplicates across accounts are averaged.
      </p>
      {loading ? (
        <ChartSkeleton label="Loading positions" height={360} />
      ) : error ? (
        <p role="alert" className="skew-empty">Position data could not be loaded for every account.</p>
      ) : !available.length ? (
        <p className="skew-empty">No open SPX option positions to derive a skew from.</p>
      ) : (
        <>
          <div className="skew-toolbar">
            <div className="skew-expiries" role="group" aria-label="Expiries to plot">
              <span className="skew-label">Expiries</span>
              {available.map(expiry => {
                const on = selected.includes(expiry);
                const color = PALETTE[available.indexOf(expiry) % PALETTE.length];
                const days = daysToExpiry(toExpiryKey(expiry), now);
                return (
                  <button
                    key={expiry}
                    type="button"
                    className={`skew-chip${on ? " on" : ""}`}
                    aria-pressed={on}
                    onClick={() => toggle(expiry)}
                    style={on ? { borderColor: color } : undefined}
                  >
                    <i style={{ background: on ? color : "transparent", borderColor: color }} />
                    {expiry}
                    <small>{days < 1 ? `${Math.max(0, days * 24).toFixed(0)}h` : `${Math.ceil(days)}d`}</small>
                  </button>
                );
              })}
            </div>
            <div className="skew-options">
              <div className="segmented sm" role="group" aria-label="Horizontal axis">
                <button type="button" className={axis === "strike" ? "on" : ""} aria-pressed={axis === "strike"} onClick={() => setAxis("strike")}>Strike</button>
                <button type="button" className={axis === "moneyness" ? "on" : ""} aria-pressed={axis === "moneyness"} onClick={() => setAxis("moneyness")}>% of spot</button>
              </div>
              <label className="skew-check">
                <input type="checkbox" checked={showItm} onChange={e => setShowItm(e.target.checked)} />
                Show ITM marks
              </label>
            </div>
          </div>

          {series.length ? (
            <>
              <div className="risk-metrics skew-metrics" aria-label="Skew summary">
                {spot !== null && (
                  <span>
                    <small>SPX spot</small>
                    <b>{spot.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b>
                  </span>
                )}
                {series.map(s => <SkewMetric key={s.expiry} series={s} />)}
              </div>
              <SkewChart series={series} axis={axis} showItm={showItm} spot={spot} />
            </>
          ) : (
            <p className="skew-empty">Pick at least one expiry above to plot its skew.</p>
          )}

          <details className="skew-model">
            <summary>Model inputs · rate {pct(rate, 2)} · dividend {pct(dividend, 2)}</summary>
            <div className="risk-controls">
              <label>
                Risk-free rate: {pct(rate, 2)}
                <input type="range" min={-5} max={25} step={0.25} value={rate} onChange={e => setRate(Number(e.target.value))} />
              </label>
              <label>
                Dividend yield: {pct(dividend, 2)}
                <input type="range" min={0} max={10} step={0.1} value={dividend} onChange={e => setDividend(Number(e.target.value))} />
              </label>
              <button type="button" className="skew-reset" onClick={() => { setRate(DEFAULT_RATE * 100); setDividend(DEFAULT_DIV_YIELD * 100); }}>
                Reset
              </button>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

function SkewMetric({ series }: { series: Series }) {
  const atm = interpolateIv(series.curve, series.spot);
  const lo = series.curve[0]?.strike ?? 0, hi = series.curve[series.curve.length - 1]?.strike ?? 0;
  const downside = series.spot * 0.95;
  const put = downside >= lo ? interpolateIv(series.curve, downside) : null;
  return (
    <span>
      <small style={{ color: series.color }}>{series.expiry}</small>
      <b>
        {atm === null ? "—" : pct(atm * 100)}
        <small>ATM</small>
        {put !== null && atm !== null && (
          <>
            {`${put >= atm ? "+" : ""}${((put - atm) * 100).toFixed(1)}`}
            <small>vol pts at 95%</small>
          </>
        )}
      </b>
      <small>{series.curve.length} strikes · {lo.toLocaleString()}–{hi.toLocaleString()}</small>
    </span>
  );
}

function SkewChart({ series, axis, showItm, spot }: { series: Series[]; axis: Axis; showItm: boolean; spot: number | null }) {
  const x = (p: SkewPoint, s: Series) => (axis === "strike" ? p.strike : (p.strike / s.spot) * 100);
  const shown = series.flatMap(s => [...s.curve, ...(showItm ? s.itm : [])].map(p => ({ x: x(p, s), iv: p.iv * 100 })));
  const xs = shown.map(p => p.x), ivs = shown.map(p => p.iv);
  const spotX = spot === null ? null : axis === "strike" ? spot : 100;
  const allX = spotX === null ? xs : [...xs, spotX];
  const xMin = Math.min(...allX), xMax = Math.max(...allX);
  const xPad = Math.max((xMax - xMin) * 0.06, axis === "strike" ? 5 : 0.25);
  const yMin = Math.min(...ivs), yMax = Math.max(...ivs);
  const yPad = Math.max((yMax - yMin) * 0.15, 1);
  const decimals = axis === "strike" ? 0 : 1;
  const round = (v: number, up: boolean) => {
    const f = 10 ** decimals;
    return (up ? Math.ceil(v * f) : Math.floor(v * f)) / f;
  };

  return (
    <Chart
      height={380}
      ariaLabel={`SPX implied volatility skew for ${series.map(s => s.expiry).join(", ")}, from the desk's own positions`}
      unavailable="Chart unavailable."
      deps={[series, axis, showItm, spot]}
      option={(t, zoom) => ({
        animation: false,
        tooltip: {
          trigger: "item",
          confine: true,
          backgroundColor: t.raised,
          borderColor: t.line,
          textStyle: { color: t.text },
          formatter: (p: { seriesName: string; data: { value: [number, number]; point: SkewPoint; spot: number; itm: boolean } }) => {
            const { point, spot: s, itm } = p.data;
            const m = (point.strike / s) * 100;
            return [
              `<b>${p.seriesName.replace(" ITM", "")}</b>`,
              `Strike ${point.strike.toLocaleString()} · ${point.right === "C" ? "Call" : "Put"} · ${itm ? "ITM" : "OTM"}`,
              `${m.toFixed(1)}% of spot`,
              `IV <b>${(point.iv * 100).toFixed(2)}%</b>`,
              point.positions > 1 ? `Averaged over ${point.positions} positions` : "",
            ].filter(Boolean).join("<br/>");
          },
        },
        grid: { left: 8, right: 24, top: 24, bottom: 64, containLabel: true },
        dataZoom: [
          { type: "inside", xAxisIndex: 0, filterMode: "none", start: zoom.start, end: zoom.end },
          {
            type: "slider",
            xAxisIndex: 0,
            filterMode: "none",
            start: zoom.start,
            end: zoom.end,
            height: 18,
            bottom: 8,
            borderColor: t.line,
            fillerColor: "rgba(128,128,128,0.15)",
            textStyle: { color: t.muted },
            showDataShadow: false,
            labelFormatter: (v: number) => (axis === "strike" ? Math.round(v).toLocaleString() : `${v.toFixed(1)}%`),
          },
        ],
        xAxis: {
          type: "value",
          name: axis === "strike" ? "Strike" : "Strike as % of spot",
          nameLocation: "middle",
          nameGap: 28,
          min: round(xMin - xPad, false),
          max: round(xMax + xPad, true),
          axisLine: { lineStyle: { color: t.line } },
          axisTick: { show: false },
          axisLabel: { color: t.muted, hideOverlap: true, formatter: (v: number) => (axis === "strike" ? v.toLocaleString() : `${v}%`) },
          nameTextStyle: { color: t.muted },
          splitLine: { lineStyle: { color: t.grid } },
        },
        yAxis: {
          type: "value",
          min: Math.max(0, Math.floor(yMin - yPad)),
          max: Math.ceil(yMax + yPad),
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: t.muted, formatter: "{value}%" },
          splitLine: { lineStyle: { color: t.grid } },
        },
        series: series.flatMap((s, i) => [
          {
            name: s.expiry,
            type: "line",
            color: s.color,
            smooth: 0.25,
            showSymbol: true,
            symbolSize: 7,
            lineStyle: { width: 2.5, color: s.color },
            itemStyle: { color: s.color },
            emphasis: { focus: "series" },
            data: s.curve.map(p => ({ value: [x(p, s), p.iv * 100], point: p, spot: s.spot, itm: false, symbol: p.right === "P" ? "triangle" : "circle" })),
            ...(i === 0 && spotX !== null
              ? {
                  markLine: {
                    silent: true,
                    symbol: "none",
                    lineStyle: { color: t.muted, type: "dashed", width: 1 },
                    label: { color: t.muted, formatter: axis === "strike" ? `Spot ${Math.round(spot!).toLocaleString()}` : "Spot", position: "insideEndTop" },
                    data: [{ xAxis: spotX }],
                  },
                }
              : {}),
          },
          ...(showItm && s.itm.length
            ? [
                {
                  name: `${s.expiry} ITM`,
                  type: "line",
                  color: s.color,
                  showSymbol: true,
                  symbol: "emptyCircle",
                  symbolSize: 6,
                  lineStyle: { opacity: 0 },
                  itemStyle: { color: s.color, opacity: 0.55 },
                  data: s.itm.map(p => ({ value: [x(p, s), p.iv * 100], point: p, spot: s.spot, itm: true })),
                },
              ]
            : []),
        ]),
      })}
    />
  );
}
