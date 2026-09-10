"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Position } from "@/lib/types";
import { Assumption, brokerSpot, buildCurves, numeric, prepareLegs, underlyingKey, upsideRisks, validAssumption } from "@/lib/payoff";
import { money, positionLabel } from "./tables";

type Points = ReturnType<typeof buildCurves>;
function PayoffChart({ points, currency, light, desk }: { points: Points; currency: string; light: boolean; desk: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void Promise.all([import("echarts/core"), import("echarts/charts"), import("echarts/components"), import("echarts/renderers")]).then(([ec, charts, components, renderers]) => {
      if (cancelled || !ref.current) return;
      ec.use([charts.LineChart, components.GridComponent, components.TooltipComponent, components.LegendComponent, components.MarkLineComponent, renderers.SVGRenderer]);
      const chart = ec.init(ref.current, undefined, { renderer: "svg" });
      const styles = getComputedStyle(ref.current);
      const muted = styles.getPropertyValue("--muted").trim();
      const grid = styles.getPropertyValue("--grid").trim();
      chart.setOption({
        animation: false,
        legend: { type: "scroll", textStyle: { color: muted } },
        tooltip: { trigger: "axis", confine: true, renderMode: "richText", valueFormatter: (v: number) => money(String(v)) },
        grid: { left: 12, right: 22, top: 50, bottom: 50, containLabel: true },
        xAxis: { type: "value", name: "Underlying move (%)", nameLocation: "middle", nameGap: 30, axisLabel: { color: muted }, nameTextStyle: { color: muted }, splitLine: { lineStyle: { color: grid } } },
        yAxis: { type: "value", name: `P&L (${currency})`, axisLabel: { color: muted }, nameTextStyle: { color: muted }, splitLine: { lineStyle: { color: grid } } },
        series: [
          { name: desk ? "Desk terminal" : "Account terminal", type: "line", showSymbol: false, data: points.map(p => [p.shock, p.terminal]), lineStyle: { width: 3 }, markLine: { silent: true, symbol: "none", label: { show: false }, data: [{ yAxis: 0 }, { xAxis: 0 }] } },
          { name: "Pre-expiry estimate", type: "line", showSymbol: false, data: points.map(p => [p.shock, p.modeled]), lineStyle: { type: "dashed", width: 2 } },
          ...(desk ? Object.keys(points[0]?.accounts ?? {}).map(account => ({ name: `${account} terminal`, type: "line", showSymbol: false, data: points.map(p => [p.shock, p.accounts[account]]), lineStyle: { width: 1 } })) : []),
        ],
      });
      const observer = new ResizeObserver(() => chart.resize());
      observer.observe(ref.current);
      dispose = () => { observer.disconnect(); chart.dispose(); };
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; dispose?.(); };
  }, [points, currency, light, desk]);
  return failed ? <p role="alert">Chart unavailable. Scenario values are available in the table below.</p> : <div ref={ref} style={{ height: 360 }} role="img" aria-label={`Terminal payoff and pre-expiry estimated P&L in ${currency} against underlying percentage move`} />;
}

export const PayoffPanel = memo(function PayoffPanel({ rows, accountId, loading, error, light }: { rows: Position[]; accountId?: string; loading: boolean; error: boolean; light: boolean }) {
  const [currencyChoice, setCurrency] = useState("");
  const [overrides, setOverrides] = useState<Record<string, Partial<Assumption>>>({});
  const [range, setRange] = useState(50);
  const [days, setDays] = useState(0);
  const [rate, setRate] = useState(0);
  const [today, setToday] = useState(() => new Date().toISOString().slice(0, 10));
  useEffect(() => {
    const timer = setInterval(() => setToday(new Date().toISOString().slice(0, 10)), 60000);
    return () => clearInterval(timer);
  }, []);
  const currencies = [...new Set(rows.filter(p => numeric(p.quantity) !== 0).map(p => p.currency || "Unknown"))].sort();
  const currency = currencies.includes(currencyChoice) ? currencyChoice : currencies[0] ?? "";
  const scoped = rows.filter(p => (p.currency || "Unknown") === currency);
  const { legs, excluded } = prepareLegs(scoped, today);
  const keys = [...new Set(legs.map(l => underlyingKey(l.position)))].sort();
  const assumptions: Record<string, Assumption> = {};
  const quoted: Record<string, number | undefined> = {};
  for (const key of keys) {
    quoted[key] = brokerSpot(legs, key);
    assumptions[key] = { spot: quoted[key] ?? NaN, volatility: 0.3, dividend: 0, ...overrides[key] };
  }
  const missing = keys.filter(key => !validAssumption(assumptions[key]));
  const maxDays = Math.min(365, ...legs.filter(l => l.position.sec_type === "OPT").map(l => l.days));
  const horizon = Math.min(days, maxDays);
  const ready = !loading && !error && legs.length > 0 && missing.length === 0;
  const points = ready ? buildCurves(legs, assumptions, range, horizon, rate / 100) : [];
  const tails = upsideRisks(legs);
  const change = (key: string, field: keyof Assumption, value: string) => setOverrides(prev => {
    const next = { ...prev[key] };
    if (field === "spot" && value.trim() === "") delete next.spot;
    else next[field] = value.trim() === "" ? NaN : Number(value) / (field === "spot" ? 1 : 100);
    return { ...prev, [key]: next };
  });
  const scenarioRows = points.length ? [points[0], points.find(p => p.shock === 0)!, points[points.length - 1]] : [];
  return <section className="panel payoff-panel">
    <h2>{accountId ? "Account payoff & risk" : "Desk payoff & risk"}</h2>
    <p className="footnote">{accountId ? `Account ${accountId}` : "All accessible accounts"} · Open-position P&L relative to average cost · Currencies are calculated separately; no FX conversion.</p>
    {loading ? <p role="status">Loading all account positions…</p> : error ? <p role="alert">Position data could not be loaded for every account. Risk curves are unavailable until all accounts load.</p> : !currencies.length ? <p>No open positions to model.</p> : <>
      <div className="risk-controls">
        <label>Risk currency<select value={currency} onChange={e => setCurrency(e.target.value)}>{currencies.map(c => <option key={c}>{c}</option>)}</select></label>
        <label>Shock range<select value={range} onChange={e => setRange(Number(e.target.value))}>{[25, 50, 100, 200].map(n => <option key={n} value={n}>−{Math.min(n, 100)}% to +{n}%</option>)}</select></label>
        <label>Days forward: {horizon}<input type="range" min={0} max={maxDays} step={1} value={horizon} onChange={e => setDays(Number(e.target.value))} /></label>
        <label>Annual interest: {rate}%<input type="range" min={-5} max={25} step={0.25} value={rate} onChange={e => setRate(Number(e.target.value))} /></label>
      </div>
      <p className="footnote">{legs.length} included legs · {excluded.length} excluded legs in {currency}. Model date: {today} (UTC); horizon stops at the earliest included expiry. Reference prices come from the broker: a held stock’s mark, else the underlying price IB computes for the options on it. Type over one to model a different level, or clear the field to hand it back to the feed. Volatility defaults to an assumed 30%.</p>
      {keys.length > 0 && <div className="risk-assumptions">{keys.map(key => <fieldset key={key}>
        <legend>{key}</legend>
        <label>Reference price<input type="number" min="0.000001" step="any" value={Number.isFinite(assumptions[key].spot) ? assumptions[key].spot : ""} onChange={e => change(key, "spot", e.target.value)} /></label>
        <p className="footnote">{overrides[key]?.spot !== undefined ? `Manual override; broker mark ${quoted[key] === undefined ? "unavailable" : money(String(quoted[key]))}` : quoted[key] === undefined ? "No broker mark available — enter a reference price" : "Live broker mark"}</p>
        <label>Volatility (%)<input type="number" min="0" max="500" step="any" value={Number.isFinite(assumptions[key].volatility) ? assumptions[key].volatility * 100 : ""} onChange={e => change(key, "volatility", e.target.value)} /></label>
        <label>Dividend yield (%)<input type="number" min="0" max="100" step="any" value={Number.isFinite(assumptions[key].dividend) ? assumptions[key].dividend * 100 : ""} onChange={e => change(key, "dividend", e.target.value)} /></label>
      </fieldset>)}</div>}
      {missing.length > 0 && <p role="status">Enter valid assumptions for {missing.join(", ")} to calculate the curve.</p>}
      {excluded.length > 0 && <details><summary>Partial coverage: {excluded.length} excluded legs</summary><ul>{excluded.map(({ position: p, reason }) => <li key={`${p.account_id}:${p.con_id}`}>{p.account_id} · {positionLabel(p)}: {reason}</li>)}</ul></details>}
      {tails.length > 0 && <p className="risk-warning">Potential uncapped upside exposure: {tails.join(", ")}. Calls at different expiries are not treated as guaranteed hedges.</p>}
      {ready && <>
        <PayoffChart points={points} currency={currency} light={light} desk={!accountId} />
        <div className="risk-metrics"><span>Worst terminal P&L in plotted range <b>{money(String(Math.min(...points.map(p => p.terminal))))} {currency}</b></span><span>Worst estimated P&L in sampled range <b>{money(String(Math.min(...points.map(p => p.modeled))))} {currency}</b></span></div>
        <div className="risk-table"><table><caption>Scenario P&L ({currency})</caption><thead><tr><th>Underlying move</th><th>Terminal payoff</th><th>Pre-expiry estimate</th>{!accountId && Object.keys(points[0].accounts).map(a => <th key={a}>{a} terminal</th>)}</tr></thead><tbody>{scenarioRows.map(p => <tr key={p.shock}><th>{p.shock.toFixed(0)}%</th><td>{money(String(p.terminal))}</td><td>{money(String(p.modeled))}</td>{!accountId && Object.entries(p.accounts).map(([a, value]) => <td key={a}>{money(String(value))}</td>)}</tr>)}</tbody></table></div>
      </>}
      <p className="footnote">Terminal payoff applies the same percentage move to every underlying at each option’s own expiry; mixed expiries do not represent a single-date liquidation. Pre-expiry estimates use European Black–Scholes with constant assumed volatility and dividend yield. Early exercise, assignment, volatility skew, fees and cash flows are not modeled. Stocks and standard stock options only; adjusted contracts cannot be identified from this feed. Grouping assumes the same symbol and currency identify the same underlying. These are hypothetical scenarios, not broker marks or a maximum-loss guarantee.</p>
    </>}
  </section>;
}, (previous, next) => previous.accountId === next.accountId && previous.loading === next.loading && previous.error === next.error && previous.light === next.light && previous.rows.length === next.rows.length && previous.rows.every((row, index) => row === next.rows[index]));
