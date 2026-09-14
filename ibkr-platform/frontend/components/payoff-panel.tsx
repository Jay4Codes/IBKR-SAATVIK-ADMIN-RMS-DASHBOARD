"use client";

import { memo, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Position, RealizedSummary } from "@/lib/types";
import { ASSUMED_VOL, Assumption, brokerSpot, buildCurves, DEFAULT_DIV_YIELD, DEFAULT_RATE, expiryDate, impliedByUnderlying, numeric, prepareLegs, RMS_SHOCKS, spotLabel, underlyingKey, upsideRisks, validAssumption } from "@/lib/payoff";
import { ChevronDown, ChevronUp, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StrategyPayoff } from "./strategy-payoff";
import { SearchableSelect } from "./searchable-select";
import { Amount, money, positionLabel } from "./tables";
import { useZone } from "./timezone";
import { todayIn } from "@/lib/timezone";

export const PayoffPanel = memo(function PayoffPanel({ rows, accountId, loading, error, light }: { rows: Position[]; accountId?: string; loading: boolean; error: boolean; light: boolean }) {
  const [currencyChoice, setCurrency] = useState("");
  const [overrides, setOverrides] = useState<Record<string, Partial<Assumption>>>({});
  const [range, setRange] = useState(10);
  const [withCommissions, setWithCommissions] = useState(false);
  const [withClosed, setWithClosed] = useState(true);
  const [days, setDays] = useState(0);
  const [rate, setRate] = useState(DEFAULT_RATE * 100);
  const zone = useZone();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const today = todayIn(zone);
  const currencies = [...new Set(rows.filter(p => numeric(p.quantity) !== 0).map(p => p.currency || "Unknown"))].sort();
  const currency = currencies.includes(currencyChoice) ? currencyChoice : currencies[0] ?? "";
  const scoped = rows.filter(p => (p.currency || "Unknown") === currency);
  const { legs: allLegs, excluded } = prepareLegs(scoped, now);
  const [expiryChoice, setExpiry] = useState("");
  const expiries = [...new Set(allLegs.map(l => l.position.expiry).filter(Boolean))].sort();
  const expiry = expiries.includes(expiryChoice) ? expiryChoice : "";
  const legs = expiry ? allLegs.filter(l => l.position.expiry === expiry) : allLegs;
  const keys = [...new Set(legs.map(l => underlyingKey(l.position)))].sort();
  const assumptions: Record<string, Assumption> = {};
  const quoted: Record<string, number | undefined> = {};
  const marks: Record<string, ReturnType<typeof brokerSpot>> = {};
  const marketVol = impliedByUnderlying(legs, rate / 100, DEFAULT_DIV_YIELD);
  for (const key of keys) {
    marks[key] = brokerSpot(legs, key);
    quoted[key] = marks[key]?.price;
    assumptions[key] = {
      spot: quoted[key] ?? NaN,
      volatility: marketVol[key] ?? ASSUMED_VOL,
      dividend: DEFAULT_DIV_YIELD,
      ...overrides[key],
    };
  }
  const missing = keys.filter(key => !validAssumption(assumptions[key]));
  const maxDays = Math.min(365, ...legs.filter(l => l.position.sec_type === "OPT").map(l => l.days));
  const horizon = Math.min(days, maxDays);
  const horizonLabel = Number.isFinite(maxDays)
    ? new Date(now + horizon * 86400000).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
    : `${horizon.toFixed(1)}d`;
  const ready = !loading && !error && legs.length > 0 && missing.length === 0;
  const points = ready ? buildCurves(legs, assumptions, range, horizon, rate / 100) : [];
  const tails = upsideRisks(legs);
  const activeOn = todayIn("ET", now).replace(/-/g, "");
  const realizedQuery = useQuery({
    queryKey: ["realized", accountId ?? "desk", expiry, activeOn],
    queryFn: () => api<RealizedSummary>(
      `/realized?active_on=${activeOn}` +
      (expiry ? `&expiries=${encodeURIComponent(expiry)}` : "") +
      (accountId ? `&accounts=${encodeURIComponent(accountId)}` : "")
    ),
  });
  const realizedLegs = (realizedQuery.data?.legs ?? []).filter(
    leg => (leg.currency || "Unknown") === currency
  );
  const realizedCommission = realizedLegs.reduce((sum, leg) => sum + (numeric(leg.commission) ?? 0), 0);
  const legPnl = (leg: (typeof realizedLegs)[number]) =>
    (numeric(leg.realized_pnl) ?? 0) - (withCommissions ? (numeric(leg.commission) ?? 0) : 0);
  const booked = realizedLegs.reduce((sum, leg) => sum + legPnl(leg), 0);
  const realized = withClosed ? booked : 0;
  const realizedByAccount: Record<string, number> = {};
  if (withClosed) {
    for (const leg of realizedLegs) {
      realizedByAccount[leg.account_id] = (realizedByAccount[leg.account_id] ?? 0) + legPnl(leg);
    }
  }
  const bookedFor = (account?: string) => account ? (realizedByAccount[account] ?? 0) : realized;
  const adjusted = realized === 0 && Object.keys(realizedByAccount).length === 0 ? points : points.map(point => ({
    ...point,
    terminal: point.terminal + realized,
    modeled: point.modeled + realized,
    accounts: Object.fromEntries(
      Object.entries(point.accounts).map(([account, value]) => [account, value + bookedFor(account)])
    ),
  }));
  const change = (key: string, field: keyof Assumption, value: string) => setOverrides(prev => {
    const next = { ...prev[key] };
    if (field === "spot" && value.trim() === "") delete next.spot;
    else next[field] = value.trim() === "" ? NaN : Number(value) / (field === "spot" ? 1 : 100);
    return { ...prev, [key]: next };
  });
  const [inputs, setInputs] = useState(false);
  const scenarioRows = adjusted.filter(p => RMS_SHOCKS.includes(p.shock as (typeof RMS_SHOCKS)[number]));
  const currentPoint = adjusted.find(point => point.shock === 0);
  const openPoint = points.find(point => point.shock === 0);
  const accountIds = points.length ? Object.keys(points[0].accounts).sort() : [];
  const scenarioLevel = (shock: number) => keys
    .map(key => `${key.split(":").at(-1)} ${money(String(assumptions[key].spot * (1 + shock / 100)))}`)
    .join(" · ");
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
      <p className="footnote">{legs.length} included legs · {excluded.length} excluded legs in {currency}. Model clock: {today} ({zone}); time to expiry runs to the 16:00 New York close, and the horizon stops at the earliest included expiry. Reference prices come from the broker: a held stock’s mark, else the underlying price IB computes for the options on it. Type over one to model a different level, or clear the field to hand it back to the feed. Volatility defaults to an assumed 30%.</p>
      {keys.length > 0 && <div className="risk-assumptions">{keys.map(key => <fieldset key={key}>
        <legend>{key}</legend>
        <label>Volatility (%)<input type="number" min="0" max="500" step="any" value={Number.isFinite(assumptions[key].volatility) ? assumptions[key].volatility * 100 : ""} onChange={e => change(key, "volatility", e.target.value)} /></label>
        <label>Dividend yield (%)<input type="number" min="0" max="100" step="any" value={Number.isFinite(assumptions[key].dividend) ? assumptions[key].dividend * 100 : ""} onChange={e => change(key, "dividend", e.target.value)} /></label>
      </fieldset>)}</div>}
      </div>
      <div className="reference-bar">
        {keys.map(key => <label key={key}>
          <span>{key.split(":").at(-1)} reference price</span>
          <input type="number" min="0.000001" step="any" inputMode="decimal"
            placeholder={quoted[key] === undefined ? "Enter a price" : money(String(quoted[key]))}
            aria-label={`${key.split(":").at(-1)} reference price`}
            value={overrides[key]?.spot !== undefined && Number.isFinite(overrides[key]!.spot) ? overrides[key]!.spot : ""}
            onChange={e => change(key, "spot", e.target.value)} />
          <small>{overrides[key]?.spot !== undefined
            ? `Modelling ${money(String(assumptions[key].spot))} · broker mark ${quoted[key] === undefined ? "unavailable" : money(String(quoted[key]))}`
            : quoted[key] === undefined ? "No broker mark — enter a price" : spotLabel(marks[key]?.source ?? "")}</small>
        </label>)}
        {keys.some(key => overrides[key]?.spot !== undefined) && <span className="bar-action"><Button type="button" variant="ghost" size="sm" onClick={() => setOverrides({})}>Reset to broker marks</Button></span>}
        {keys.map(key => <label key={`${key}-iv`} className="iv-control">
          <span>{key.split(":").at(-1)} IV {(assumptions[key].volatility * 100).toFixed(1)}%</span>
          <input type="range" min={1} max={150} step={0.5}
            aria-label={`${key.split(":").at(-1)} implied volatility`}
            value={Number.isFinite(assumptions[key].volatility) ? assumptions[key].volatility * 100 : ASSUMED_VOL * 100}
            onChange={e => change(key, "volatility", e.target.value)} />
          <small>{overrides[key]?.volatility !== undefined
            ? `Manual · market ${((marketVol[key] ?? ASSUMED_VOL) * 100).toFixed(1)}%`
            : marketVol[key] === undefined ? "No invertible marks — assumed" : "From broker option marks"}</small>
        </label>)}
        {expiries.length > 1 && <label className="expiry-filter">
          <span>Expiry</span>
          <select value={expiry} onChange={e => setExpiry(e.target.value)}>
            <option value="">All live expiries</option>
            {expiries.map(e => <option key={e} value={e}>{expiryDate(e) || e}</option>)}
          </select>
        </label>}
        {booked !== 0 && <label className="commission-toggle">
          <input type="checkbox" checked={withClosed} onChange={e => setWithClosed(e.target.checked)} />
          <span>Include closed legs</span>
          <small><Amount value={String(booked)} /> {currency} booked</small>
        </label>}
        <label className="commission-toggle">
          <input type="checkbox" checked={withCommissions} onChange={e => setWithCommissions(e.target.checked)} />
          <span>Include commissions</span>
        </label>
      </div>
      {missing.length > 0 && <p role="status">Enter valid assumptions for {missing.join(", ")} to calculate the curve.</p>}
      {excluded.length > 0 && <details><summary>Partial coverage: {excluded.length} excluded legs</summary><ul>{excluded.map(({ position: p, reason }) => <li key={`${p.account_id}:${p.con_id}`}>{p.account_id} · {positionLabel(p)}: {reason}</li>)}</ul></details>}
      {tails.length > 0 && <p className="risk-warning">Potential uncapped upside exposure: {tails.join(", ")}. Calls at different expiries are not treated as guaranteed hedges.</p>}
      {ready && <>
        <div className="risk-table"><table className="scenario-grid"><caption>RMS by account ID · Scenario P&amp;L ({currency}){realized !== 0 && " · includes booked P&L from closed legs"}</caption>
          <thead><tr><th scope="col">Measure</th>{scenarioRows.map(p => <th key={p.shock} scope="col">{p.shock > 0 ? "+" : ""}{p.shock.toFixed(0)}%</th>)}</tr></thead>
          <tbody>
            <tr><th scope="row">Scenario underlying level</th>{scenarioRows.map(p => <td key={p.shock}>{scenarioLevel(p.shock)}</td>)}</tr>
            {realized !== 0 && <>
              <tr><th scope="row">Open legs terminal</th>{scenarioRows.map(p => <td key={p.shock}><Amount value={String(p.terminal - realized)} /></td>)}</tr>
              <tr className="booked"><th scope="row">Booked P&amp;L (closed legs)</th>{scenarioRows.map(p => <td key={p.shock}><Amount value={String(realized)} /></td>)}</tr>
            </>}
            <tr className="total"><th scope="row">{accountId ? accountId : "Desk total"} terminal</th>{scenarioRows.map(p => <td key={p.shock}><Amount value={String(p.terminal)} /></td>)}</tr>
            <tr><th scope="row">Pre-expiry estimate</th>{scenarioRows.map(p => <td key={p.shock}><Amount value={String(p.modeled)} /></td>)}</tr>
            {!accountId && accountIds.map(a => <tr key={a}><th scope="row">{a} terminal</th>{scenarioRows.map(p => <td key={p.shock}><Amount value={String(p.accounts[a])} /></td>)}</tr>)}
          </tbody>
        </table></div>
        <StrategyPayoff
          legs={legs} assumptions={assumptions} keys={keys} currency={currency}
          rate={rate} offset={realized} light={light} range={range}
          horizon={horizon}
        />
        <div className="payoff-sliders">
          <label>
            <span>Date <b>{horizonLabel}</b>{maxDays > 0 && <small>{(maxDays - horizon).toFixed(1)}d to expiry</small>}</span>
            <input type="range" min={0} max={maxDays} step={0.1} value={horizon}
              aria-label="Days forward" onChange={e => setDays(Number(e.target.value))} />
          </label>
          <label>
            <span>Range <b>±{range}%</b></span>
            <input type="range" min={2} max={50} step={1} value={range}
              aria-label="Price range either side of spot" onChange={e => setRange(Number(e.target.value))} />
          </label>
        </div>
        <p className="footnote">Zoom the payoff graph by scrolling or pinching on the plot, or drag the bar below it — its handles set the range, its middle pans. The zoomed view is kept as position data refreshes. The shaded bell is the probability of each level at expiry under the IV above, not a forecast.</p>
        <div className="risk-metrics">
          {keys.map(key => <span key={key}>{key} reference <b>{money(String(assumptions[key].spot))}</b></span>)}
          {realized !== 0 && <span>Booked P&L from closed legs this cycle <b><Amount value={String(realized)} /> {currency}</b></span>}
          {realized !== 0 && <span>Open legs only, at current reference (0%) <b><Amount value={String(openPoint?.terminal)} /> {currency}</b></span>}
          <span>Expiry P&L if SPX expires at current reference (0%) <b><Amount value={String(currentPoint?.terminal)} /> {currency}</b></span>
          <span>Live marked P&L at current reference (0%) <b><Amount value={String(currentPoint?.modeled)} /> {currency}</b></span>
          <span>Worst terminal P&L across plotted expiry outcomes <b><Amount value={String(Math.min(...adjusted.map(p => p.terminal)))} /> {currency}</b></span>
          <span>Worst mark-anchored estimate in sampled range <b><Amount value={String(Math.min(...adjusted.map(p => p.modeled)))} /> {currency}</b></span>
        </div>
        {booked !== 0 && !withClosed && <p className="footnote">Open legs only. <Amount value={String(booked)} /> {currency} of P&amp;L booked on closed legs this cycle is excluded — an adjustment that closed a strike at a loss and opened another leaves that loss out of the open positions entirely, so every figure here reads as though it never happened.</p>}
        {realized !== 0 && <p className="footnote">Booked P&amp;L covers {realizedLegs.filter(l => numeric(l.realized_pnl) !== 0).length} closed {realizedLegs.filter(l => numeric(l.realized_pnl) !== 0).length === 1 ? "leg" : "legs"} on the {[...new Set(realizedLegs.filter(l => numeric(l.realized_pnl) !== 0).map(l => l.expiry).filter(Boolean))].join(", ") || "live"} cycle — an adjustment that closes a strike at a loss and opens another leaves that loss out of the open positions entirely, so it is added back here as a constant. {withCommissions
            ? `Net of the ${money(String(realizedCommission))} ${currency} commission paid on those fills.`
            : `Gross of commissions; ${money(String(realizedCommission))} ${currency} of commission was paid on those fills, and is excluded above.`} Every figure above and in the table below includes it.</p>}
        <p className="footnote">The live marked value and mark-anchored estimates update with IBKR position marks over WebSocket. Expiry values change only when the scenario crosses a strike; a defined-risk strategy&rsquo;s worst terminal loss can remain fixed as SPX moves.</p>
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
