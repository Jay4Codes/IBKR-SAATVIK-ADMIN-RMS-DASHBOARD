"use client";

import { memo, useEffect, useState } from "react";
import { Position } from "@/lib/types";
import { Assumption, brokerSpot, buildCurves, numeric, prepareLegs, RMS_SHOCKS, spotLabel, underlyingKey, upsideRisks, validAssumption } from "@/lib/payoff";
import { ChevronDown, ChevronUp, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chart } from "./chart";
import { SearchableSelect } from "./searchable-select";
import { Amount, money, positionLabel } from "./tables";
import { useZone } from "./timezone";
import { todayIn } from "@/lib/timezone";

type Points = ReturnType<typeof buildCurves>;

function PayoffChart({ points, currency, light, desk, version }: { points: Points; currency: string; light: boolean; desk: boolean; version: string }) {
  return <Chart
    height={400}
    ariaLabel={`Zoomable terminal payoff and pre-expiry estimated P&L in ${currency} against underlying percentage move`}
    unavailable="Chart unavailable. Scenario values are available in the table below."
    deps={[version, currency, light, desk]}
    option={(t, zoom) => ({
      animation: false,
      /* Pinned to the top: echarts 6 puts an unpositioned legend at the bottom,
         where it landed on top of the zoom slider and hid it. */
      legend: { type: "scroll", top: 6, left: "center", itemGap: 18, itemWidth: 18, itemHeight: 10, textStyle: { color: t.muted }, inactiveColor: t.line, pageIconColor: t.accent, pageIconInactiveColor: t.muted, pageTextStyle: { color: t.muted } },
      tooltip: { trigger: "axis", confine: true, renderMode: "richText", valueFormatter: (v: number) => money(String(v)) },
      /* Reserves the top strip for the legend and the bottom for the axis name
         plus the slider, which sits in the last 44px. */
      grid: { left: 16, right: 24, top: 46, bottom: 96, containLabel: true },
      dataZoom: [
        { type: "inside", xAxisIndex: 0, filterMode: "none", ...zoom },
        {
          type: "slider", xAxisIndex: 0, filterMode: "none", ...zoom, bottom: 14, height: 30, brushSelect: false,
          backgroundColor: "transparent", borderColor: t.line, fillerColor: `${t.accent}26`,
          dataBackground: { lineStyle: { color: t.muted, width: 1, opacity: 0.7 }, areaStyle: { color: t.muted, opacity: 0.18 } },
          selectedDataBackground: { lineStyle: { color: t.accent, width: 1 }, areaStyle: { color: t.accent, opacity: 0.28 } },
          handleSize: "110%", handleStyle: { color: t.raised, borderColor: t.lineStrong, borderWidth: 1, shadowBlur: 0 },
          moveHandleSize: 6, moveHandleStyle: { color: t.lineStrong },
          textStyle: { color: t.muted }, labelFormatter: (v: number) => `${v > 0 ? "+" : ""}${Math.round(v)}%`,
        },
      ],
      xAxis: { type: "value", name: "Underlying move (%)", nameLocation: "middle", nameGap: 26, axisLine: { lineStyle: { color: t.line } }, axisTick: { show: false }, axisLabel: { color: t.muted }, nameTextStyle: { color: t.muted }, splitLine: { lineStyle: { color: t.grid } } },
      /* Rotated down the left edge; as a top-anchored name it collided with the legend. */
      yAxis: { type: "value", name: `P&L (${currency})`, nameLocation: "middle", nameRotate: 90, nameGap: 58, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.muted }, nameTextStyle: { color: t.muted }, splitLine: { lineStyle: { color: t.grid } } },
      series: [
        { name: desk ? "Desk terminal" : "Account terminal", type: "line", showSymbol: false, data: points.map(p => [p.shock, p.terminal]), lineStyle: { width: 3 }, markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: t.lineStrong }, data: [{ yAxis: 0 }, { xAxis: 0 }] } },
        { name: "Pre-expiry estimate", type: "line", showSymbol: false, data: points.map(p => [p.shock, p.modeled]), lineStyle: { type: "dashed", width: 2 } },
        ...(desk ? Object.keys(points[0]?.accounts ?? {}).map(account => ({ name: `${account} terminal`, type: "line", showSymbol: false, data: points.map(p => [p.shock, p.accounts[account]]), lineStyle: { width: 1 } })) : []),
      ],
    })}
  />;
}

export const PayoffPanel = memo(function PayoffPanel({ rows, accountId, loading, error, light }: { rows: Position[]; accountId?: string; loading: boolean; error: boolean; light: boolean }) {
  const [currencyChoice, setCurrency] = useState("");
  const [overrides, setOverrides] = useState<Record<string, Partial<Assumption>>>({});
  const [range, setRange] = useState(5);
  const [days, setDays] = useState(0);
  const [rate, setRate] = useState(0);
  const zone = useZone();
  /* Days-to-expiry is measured from the reader's own calendar day, so switching
     the display zone late in the session can move the model date — and with it
     the pre-expiry estimate. The footnote below names the zone in use. */
  const today = todayIn(zone);
  // The date is derived each render, so a zone change moves it at once; this
  // tick exists only to re-render across midnight in the selected zone.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick(n => n + 1), 60000);
    return () => clearInterval(timer);
  }, []);
  const currencies = [...new Set(rows.filter(p => numeric(p.quantity) !== 0).map(p => p.currency || "Unknown"))].sort();
  const currency = currencies.includes(currencyChoice) ? currencyChoice : currencies[0] ?? "";
  const scoped = rows.filter(p => (p.currency || "Unknown") === currency);
  const { legs, excluded } = prepareLegs(scoped, today);
  const keys = [...new Set(legs.map(l => underlyingKey(l.position)))].sort();
  const assumptions: Record<string, Assumption> = {};
  const quoted: Record<string, number | undefined> = {};
  const marks: Record<string, ReturnType<typeof brokerSpot>> = {};
  for (const key of keys) {
    marks[key] = brokerSpot(legs, key);
    quoted[key] = marks[key]?.price;
    assumptions[key] = { spot: quoted[key] ?? NaN, volatility: 0.3, dividend: 0, ...overrides[key] };
  }
  const missing = keys.filter(key => !validAssumption(assumptions[key]));
  const maxDays = Math.min(365, ...legs.filter(l => l.position.sec_type === "OPT").map(l => l.days));
  const horizon = Math.min(days, maxDays);
  const ready = !loading && !error && legs.length > 0 && missing.length === 0;
  const points = ready ? buildCurves(legs, assumptions, range, horizon, rate / 100) : [];
  // ECharts is imperative, so give it a value-based dependency instead of
  // relying on an array reference. Every changed scenario value now forces a
  // series update while the chart keeps the reader's zoom window.
  const curveVersion = points.map(point =>
    `${point.shock}:${point.terminal}:${point.modeled}:${Object.entries(point.accounts).sort().flat().join(":")}`
  ).join("|");
  const tails = upsideRisks(legs);
  const change = (key: string, field: keyof Assumption, value: string) => setOverrides(prev => {
    const next = { ...prev[key] };
    if (field === "spot" && value.trim() === "") delete next.spot;
    else next[field] = value.trim() === "" ? NaN : Number(value) / (field === "spot" ? 1 : 100);
    return { ...prev, [key]: next };
  });
  /* Collapsed by default: these are the inputs, and once they are set the reader
     is here for the curve and the scenario table, not to re-read the assumptions
     above them on every visit. */
  const [inputs, setInputs] = useState(false);
  const scenarioRows = points.filter(p => RMS_SHOCKS.includes(p.shock as (typeof RMS_SHOCKS)[number]));
  const currentPoint = points.find(point => point.shock === 0);
  const referenceSummary = keys.map(key =>
    `${key.split(":").at(-1)} ${money(String(assumptions[key].spot))}`
  ).join(" · ");
  const accountIds = points.length ? Object.keys(points[0].accounts).sort() : [];
  return <section className="panel payoff-panel">
    <h2>{accountId ? "Account payoff & risk" : "Desk payoff & risk"}
      <span className="panel-actions"><Button type="button" variant="ghost" size="sm" aria-expanded={inputs} aria-controls="risk-inputs" title="Risk currency, shock range, horizon and per-underlying assumptions" onClick={() => setInputs(!inputs)}><SlidersHorizontal size={14} aria-hidden="true" />{inputs ? "Hide inputs" : "Model inputs"}{inputs ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}</Button></span>
    </h2>
    <p className="footnote">{accountId ? `Account ${accountId}` : "All accessible accounts"} · Open-position P&L relative to average cost · Currencies are calculated separately; no FX conversion.</p>
    {loading ? <p role="status">Loading all account positions…</p> : error ? <p role="alert">Position data could not be loaded for every account. Risk curves are unavailable until all accounts load.</p> : !currencies.length ? <p>No open positions to model.</p> : <>
      <div id="risk-inputs" hidden={!inputs}>
      <div className="risk-controls">
        <label>Risk currency<SearchableSelect label="Risk currency" value={currency} options={currencies} onChange={setCurrency} /></label>
        <label>Shock range<select value={range} onChange={e => setRange(Number(e.target.value))}>{[5, 10, 25, 50, 100, 200].map(n => <option key={n} value={n}>−{Math.min(n, 100)}% to +{n}%</option>)}</select></label>
        <label>Days forward: {horizon}<input type="range" min={0} max={maxDays} step={1} value={horizon} onChange={e => setDays(Number(e.target.value))} /></label>
        <label>Annual interest: {rate}%<input type="range" min={-5} max={25} step={0.25} value={rate} onChange={e => setRate(Number(e.target.value))} /></label>
      </div>
      <p className="footnote">{legs.length} included legs · {excluded.length} excluded legs in {currency}. Model date: {today} ({zone}); horizon stops at the earliest included expiry. Reference prices come from the broker: a held stock’s mark, else the underlying price IB computes for the options on it. Type over one to model a different level, or clear the field to hand it back to the feed. Volatility defaults to an assumed 30%.</p>
      {keys.length > 0 && <div className="risk-assumptions">{keys.map(key => <fieldset key={key}>
        <legend>{key}</legend>
        <label>Reference price<input type="number" min="0.000001" step="any" value={Number.isFinite(assumptions[key].spot) ? assumptions[key].spot : ""} onChange={e => change(key, "spot", e.target.value)} /></label>
        <p className="footnote">{overrides[key]?.spot !== undefined ? `Manual override; broker mark ${quoted[key] === undefined ? "unavailable" : money(String(quoted[key]))}` : quoted[key] === undefined ? "No broker mark available — enter a reference price" : spotLabel(marks[key]?.source ?? "")}</p>
        <label>Volatility (%)<input type="number" min="0" max="500" step="any" value={Number.isFinite(assumptions[key].volatility) ? assumptions[key].volatility * 100 : ""} onChange={e => change(key, "volatility", e.target.value)} /></label>
        <label>Dividend yield (%)<input type="number" min="0" max="100" step="any" value={Number.isFinite(assumptions[key].dividend) ? assumptions[key].dividend * 100 : ""} onChange={e => change(key, "dividend", e.target.value)} /></label>
      </fieldset>)}</div>}
      </div>
      {missing.length > 0 && <p role="status">Enter valid assumptions for {missing.join(", ")} to calculate the curve.</p>}
      {excluded.length > 0 && <details><summary>Partial coverage: {excluded.length} excluded legs</summary><ul>{excluded.map(({ position: p, reason }) => <li key={`${p.account_id}:${p.con_id}`}>{p.account_id} · {positionLabel(p)}: {reason}</li>)}</ul></details>}
      {tails.length > 0 && <p className="risk-warning">Potential uncapped upside exposure: {tails.join(", ")}. Calls at different expiries are not treated as guaranteed hedges.</p>}
      {ready && <>
        <p className="footnote" aria-live="polite">Graph reference: {referenceSummary}</p>
        <PayoffChart points={points} currency={currency} light={light} desk={!accountId} version={curveVersion} />
        <p className="footnote">Zoom the payoff graph by scrolling or pinching on the plot, or drag the bar below it — its handles set the range, its middle pans. The zoomed view is kept as position data refreshes.</p>
        <div className="risk-metrics">
          {keys.map(key => <span key={key}>{key} reference <b>{money(String(assumptions[key].spot))}</b></span>)}
          <span>Expiry P&L if SPX expires at current reference (0%) <b><Amount value={String(currentPoint?.terminal)} /> {currency}</b></span>
          <span>Live marked P&L at current reference (0%) <b><Amount value={String(currentPoint?.modeled)} /> {currency}</b></span>
          <span>Worst terminal P&L across plotted expiry outcomes <b><Amount value={String(Math.min(...points.map(p => p.terminal)))} /> {currency}</b></span>
          <span>Worst mark-anchored estimate in sampled range <b><Amount value={String(Math.min(...points.map(p => p.modeled)))} /> {currency}</b></span>
        </div>
        <p className="footnote">The live marked value and mark-anchored estimates update with IBKR position marks over WebSocket. Expiry values change only when the scenario crosses a strike; a defined-risk strategy&rsquo;s worst terminal loss can remain fixed as SPX moves.</p>
        <div className="risk-table"><table><caption>RMS by account ID · Scenario P&amp;L ({currency})</caption><thead><tr><th>Underlying move</th><th>Scenario underlying level</th><th>{accountId ? accountId : "Desk total"} terminal</th><th>Pre-expiry estimate</th>{!accountId && accountIds.map(a => <th key={a}>{a} terminal</th>)}</tr></thead><tbody>{scenarioRows.map(p => <tr key={p.shock}><th>{p.shock > 0 ? "+" : ""}{p.shock.toFixed(0)}%</th><td>{keys.map(key => `${key.split(":").at(-1)} ${money(String(assumptions[key].spot * (1 + p.shock / 100)))}`).join(" · ")}</td><td><Amount value={String(p.terminal)} /></td><td><Amount value={String(p.modeled)} /></td>{!accountId && accountIds.map(a => <td key={a}><Amount value={String(p.accounts[a])} /></td>)}</tr>)}</tbody></table></div>
      </>}
      <p className="footnote">Terminal payoff applies the same percentage move to every underlying at each option’s own expiry; mixed expiries do not represent a single-date liquidation. Pre-expiry estimates use European Black–Scholes with constant assumed volatility and dividend yield. Early exercise, assignment, volatility skew, fees and cash flows are not modeled. Stocks and standard stock options only; adjusted contracts cannot be identified from this feed. Grouping assumes the same symbol and currency identify the same underlying. These are hypothetical scenarios, not broker marks or a maximum-loss guarantee.</p>
    </>}
  </section>;
}, (previous, next) => previous.accountId === next.accountId && previous.loading === next.loading && previous.error === next.error && previous.light === next.light && previous.rows.length === next.rows.length && previous.rows.every((row, index) => {
  const incoming = next.rows[index];
  return row.account_id === incoming.account_id && row.con_id === incoming.con_id &&
    row.symbol === incoming.symbol && row.sec_type === incoming.sec_type &&
    row.currency === incoming.currency && row.expiry === incoming.expiry &&
    row.strike === incoming.strike && row.right === incoming.right &&
    row.multiplier === incoming.multiplier && row.quantity === incoming.quantity &&
    row.average_cost === incoming.average_cost && row.market_price === incoming.market_price &&
    row.market_value === incoming.market_value && row.unrealized_pnl === incoming.unrealized_pnl &&
    row.underlying_price === incoming.underlying_price &&
    row.underlying_source === incoming.underlying_source;
}));
