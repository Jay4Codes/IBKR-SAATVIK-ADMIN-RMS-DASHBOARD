"use client";

import { useState } from "react";
import { Position } from "@/lib/types";
import { skewByExpiry, SkewPoint } from "@/lib/payoff";
import { todayIn } from "@/lib/timezone";
import { Chart } from "./chart";
import { SearchableSelect } from "./searchable-select";
import { useZone } from "./timezone";

const SYMBOL = "SPX";

/** SPX implied-vol skew for any two expiries the reader picks, from the desk's
 *  own book.
 *
 *  Not a market-wide chain: each point is one held contract's own broker mark,
 *  inverted against Black–Scholes for the volatility that reprices it — so the
 *  strikes shown are only the ones the desk actually has a position in. That
 *  keeps this independent of a market-data vendor, using data already flowing
 *  through the position feed.
 */
export function SkewPanel({ rows, loading, error }: { rows: Position[]; loading: boolean; error: boolean }) {
  const zone = useZone();
  const today = todayIn(zone);
  const [rate, setRate] = useState(0);
  const [dividend, setDividend] = useState(0);
  const spx = rows.filter(p => p.symbol.toUpperCase() === SYMBOL && p.sec_type === "OPT");
  const groups = skewByExpiry(spx, today, rate / 100, dividend / 100);
  const available = [...groups.keys()].sort();

  const [firstChoice, setFirstChoice] = useState("");
  const [secondChoice, setSecondChoice] = useState("");
  const first = available.includes(firstChoice) ? firstChoice : available[0] ?? "";
  const second = available.includes(secondChoice) ? secondChoice : available[1] ?? available[0] ?? "";
  const firstPoints = groups.get(first) ?? [];
  const secondPoints = groups.get(second) ?? [];

  return (
    <section className="panel">
      <h2>SPX skew — the desk&rsquo;s own book</h2>
      <p className="footnote">
        Implied volatility by strike, for two SPX expiries you choose — each point is one held
        contract&rsquo;s broker mark inverted for volatility, not a market-wide chain. Only expiries
        the desk currently has a position in appear below.
      </p>
      {loading ? (
        <p role="status">Loading positions…</p>
      ) : error ? (
        <p role="alert">Position data could not be loaded for every account.</p>
      ) : !available.length ? (
        <p>No open SPX option positions to derive a skew from.</p>
      ) : (
        <>
          <div className="risk-controls">
            <label>
              First expiry
              <SearchableSelect label="First expiry" value={first} options={available} onChange={setFirstChoice} />
            </label>
            <label>
              Second expiry
              <SearchableSelect label="Second expiry" value={second} options={available} onChange={setSecondChoice} />
            </label>
            <label>Risk-free rate: {rate}%<input type="range" min={-5} max={25} step={0.25} value={rate} onChange={e => setRate(Number(e.target.value))} /></label>
            <label>Dividend yield: {dividend}%<input type="range" min={0} max={10} step={0.1} value={dividend} onChange={e => setDividend(Number(e.target.value))} /></label>
          </div>
          <SkewChart first={first} firstPoints={firstPoints} second={second} secondPoints={secondPoints} />
        </>
      )}
    </section>
  );
}

function SkewChart({ first, firstPoints, second, secondPoints }: { first: string; firstPoints: SkewPoint[]; second: string; secondPoints: SkewPoint[] }) {
  return (
    <Chart
      height={360}
      ariaLabel={`SPX implied volatility skew for ${first} and ${second}, from the desk's own positions`}
      unavailable="Chart unavailable."
      deps={[first, second, firstPoints, secondPoints]}
      option={(t) => ({
        animation: false,
        legend: { type: "scroll", top: 4, left: "center", textStyle: { color: t.muted } },
        tooltip: {
          trigger: "item",
          confine: true,
          renderMode: "richText",
          formatter: (p: { seriesName: string; data: [number, number, string] }) =>
            `${p.seriesName}\nStrike ${p.data[0]} · ${p.data[2] === "C" ? "Call" : "Put"}\nIV ${p.data[1].toFixed(2)}%`,
        },
        grid: { left: 16, right: 24, top: 40, bottom: 50, containLabel: true },
        xAxis: {
          type: "value",
          name: "Strike",
          nameLocation: "middle",
          nameGap: 26,
          axisLine: { lineStyle: { color: t.line } },
          axisTick: { show: false },
          axisLabel: { color: t.muted },
          nameTextStyle: { color: t.muted },
          splitLine: { lineStyle: { color: t.grid } },
        },
        yAxis: {
          type: "value",
          name: "Implied vol (%)",
          nameLocation: "middle",
          nameRotate: 90,
          nameGap: 50,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: t.muted },
          nameTextStyle: { color: t.muted },
          splitLine: { lineStyle: { color: t.grid } },
        },
        series: [
          {
            name: first,
            type: "line",
            showSymbol: true,
            symbolSize: 8,
            data: firstPoints.map(p => [p.strike, p.iv * 100, p.right]),
            lineStyle: { width: 3 },
          },
          ...(second && second !== first
            ? [
                {
                  name: second,
                  type: "line",
                  showSymbol: true,
                  symbolSize: 8,
                  data: secondPoints.map(p => [p.strike, p.iv * 100, p.right]),
                  lineStyle: { width: 3, type: "dashed" as const },
                },
              ]
            : []),
        ],
      })}
    />
  );
}
