"use client";

import { memo, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Position, RealizedSummary } from "@/lib/types";
import { ASSUMED_VOL, Assumption, brokerSpot, buildCurves, DEFAULT_DIV_YIELD, DEFAULT_RATE, expiryDate, impliedByUnderlying, numeric, prepareLegs, RMS_SHOCKS, signedLevels, spotLabel, underlyingKey, upsideRisks, validAssumption } from "@/lib/payoff";
import { ChevronDown, ChevronUp, Plus, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dropdown } from "./dropdown";
import { StrategyPayoff } from "./strategy-payoff";
import { SearchableSelect } from "./searchable-select";
import { Amount, money, positionLabel } from "./tables";
import { useZone } from "./timezone";
import { todayIn } from "@/lib/timezone";
import { parseLevels, parsePrices, usePersisted, writeStored } from "@/lib/persisted";

/** A column heading. Whole numbers stay whole; a 12.5% level asked for is a
 *  12.5% level shown, not the 13% a blanket rounding would have printed. */
export function levelLabel(shock: number): string {
  const shown = Number.isInteger(shock) ? String(shock) : shock.toFixed(1);
  return `${shock > 0 ? "+" : ""}${shown}%`;
}

const CUSTOM_LEVELS_KEY = "rms.levels.custom";
const PRICE_LEVELS_KEY = "rms.levels.price";
/** The percentage levels a fresh browser starts with. They are a starting
 *  point, not a fixture: every one of them can be removed. */
const DEFAULT_LEVELS = RMS_SHOCKS.filter(shock => shock > 0).join(",");
/** More than this and the grid stops being readable across a screen. */
const MAX_CUSTOM = 8;

/** One column of the scenario grid, however the reader asked for it. */
/** `id` is unique per column so React can key on it; `group` is what removing
 *  the column acts on, and a percentage's two columns share one group because
 *  ±7% is a single thing the reader added. They were the same field, which
 *  gave the −1% and +1% columns the same key. */
type Column = {
  shock: number;
  label: string;
  kind: "pct" | "price";
  id: string;
  group: string;
  /** Added by the reader rather than shipped as a default. Styled apart so it
   *  is obvious at a glance which columns are theirs to change. */
  custom: boolean;
};

/** The columns a set of percentage magnitudes and absolute prices produce.
 *
 *  A percentage is two columns and a price is one: "seven percent" asks about
 *  both directions, while "7,800" is a single place the underlying might be.
 *  A price is converted at the reference in force, so it follows the spot while
 *  still naming the level the reader typed.
 */
export function buildColumns(percents: number[], prices: number[], spot: number): Column[] {
  const columns = new Map<number, Column>();
  for (const shock of signedLevels(percents)) {
    columns.set(round(shock), {
      shock, label: levelLabel(shock), kind: "pct",
      id: `pct:${shock}`, group: `pct:${Math.abs(shock)}`,
      custom: !RMS_SHOCKS.includes(Math.abs(shock) as (typeof RMS_SHOCKS)[number]),
    });
  }
  for (const price of prices) {
    if (!(spot > 0)) continue;
    const shock = round((price / spot - 1) * 100);
    // A price that lands on an existing column replaces its heading: the reader
    // asked in prices, so the price is the more useful label of the two.
    columns.set(shock, {
      shock, label: money(String(price), 0), kind: "price",
      id: `price:${price}`, group: `price:${price}`, custom: true,
    });
  }
  return [...columns.values()].sort((a, b) => a.shock - b.shock);
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

export const COLUMN_ORDER_KEY = "rms.columns.order";

/** The grid's columns, in whatever order the desk last left them in.
 *
 *  `columns` arrives sorted by level — the natural, useful default. `order` is
 *  a list of ids from a previous visit: known ids keep the position the reader
 *  left them in, and anything not yet in that list — a level just added — is
 *  appended after them, in its own natural (level-sorted) order.
 *
 *  A newcomer is not threaded into the middle of a custom arrangement: once
 *  the reader has moved even one column, there is no longer a single
 *  well-defined "natural place" for something new to slot into — the order by
 *  then answers to the reader, not to level, and a heuristic that assumes
 *  otherwise gets it wrong the moment that order is anything but ascending
 *  (reverse it, and "insert before the next-higher level" inserts at the
 *  front instead of the back). Appending is the rule that is always right.
 */
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

/** The class every cell in a column carries, so the column reads as one thing
 *  top to bottom rather than only at its heading. */
const cellClass = (column: Column) =>
  `col ${column.kind}${column.custom ? " custom" : ""}`;

export const PayoffPanel = memo(function PayoffPanel({ rows, accountId, loading, error, light }: { rows: Position[]; accountId?: string; loading: boolean; error: boolean; light: boolean }) {
  const [currencyChoice, setCurrency] = useState("");
  const [overrides, setOverrides] = useState<Record<string, Partial<Assumption>>>({});
  const [range, setRange] = useState(10);
  const [withCommissions, setWithCommissions] = useState(false);
  const [withClosed, setWithClosed] = useState(true);
  /* Levels the desk added itself, kept in the browser so a number worth asking
     about once is still there tomorrow. Magnitudes only: each becomes a pair of
     columns, because "what about seven percent" is two questions. */
  const custom = parseLevels(usePersisted(CUSTOM_LEVELS_KEY, DEFAULT_LEVELS));
  const prices = parsePrices(usePersisted(PRICE_LEVELS_KEY, ""));
  const [draft, setDraft] = useState("");
  const [priceDraft, setPriceDraft] = useState("");
  const write = (key: string, values: number[]) =>
    writeStored(key, [...new Set(values)].sort((a, b) => a - b).join(","));
  const wanted = Math.round(Math.abs(Number(draft)) * 10) / 10;
  const canAdd =
    Number.isFinite(wanted) && wanted > 0 && wanted < 100 &&
    custom.length < MAX_CUSTOM && !custom.includes(wanted);
  const addLevel = () => {
    if (!canAdd) return;
    write(CUSTOM_LEVELS_KEY, [...custom, wanted]);
    setDraft("");
  };
  const wantedPrice = Math.round(Number(priceDraft) * 100) / 100;
  const canAddPrice =
    Number.isFinite(wantedPrice) && wantedPrice > 0 &&
    prices.length < MAX_CUSTOM && !prices.includes(wantedPrice);
  const addPrice = () => {
    if (!canAddPrice) return;
    write(PRICE_LEVELS_KEY, [...prices, wantedPrice]);
    setPriceDraft("");
  };
  const dropColumn = (column: Column) => {
    const value = Number(column.group.split(":")[1]);
    if (column.kind === "price") write(PRICE_LEVELS_KEY, prices.filter((p: number) => p !== value));
    else write(CUSTOM_LEVELS_KEY, custom.filter((p: number) => p !== value));
  };
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
  const [chosen, setChosen] = useState<string[]>([]);
  const expiries = [...new Set(allLegs.map(l => l.position.expiry).filter(Boolean))].sort();
  /* Empty means every cycle, which is also what an all-on selection means — so
     deselecting the last one falls back to all rather than modelling nothing. */
  const picked = chosen.filter(value => expiries.includes(value));
  const shown = picked.length ? picked : expiries;
  const legs = allLegs.filter(l => shown.includes(l.position.expiry));
  const toggleExpiry = (value: string) =>
    setChosen(current => {
      /* Toggles against what is *effectively* shown, not against the stored
         list: with none stored every cycle is on, so the first click has to
         take one away rather than reduce the selection to it. */
      const next = shown.includes(value) ? shown.filter(e => e !== value) : [...shown, value];
      // All of them selected is the same statement as none of them.
      return next.length === expiries.length ? [] : next;
    });
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
  /* Price columns are only meaningful against one underlying: "7,800" means
     nothing when the grid is adding two different instruments together. */
  const priceLevels = keys.length === 1 ? prices : [];
  const naturalColumns = buildColumns(custom, priceLevels, assumptions[keys[0]]?.spot ?? 0);
  const columnOrder = usePersisted(COLUMN_ORDER_KEY, "").split(",").filter(Boolean);
  const columns = orderColumns(naturalColumns, columnOrder);
  const moveColumn = (id: string, delta: -1 | 1) => {
    const ids = columns.map(column => column.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    writeStored(COLUMN_ORDER_KEY, ids.join(","));
  };
  const levels = columns.map(column => column.shock);
  const points = ready ? buildCurves(legs, assumptions, range, horizon, rate / 100, levels) : [];
  const tails = upsideRisks(legs);
  const activeOn = todayIn("ET", now).replace(/-/g, "");
  const cycles = picked.length ? picked.join(",") : "";
  const realizedQuery = useQuery({
    queryKey: ["realized", accountId ?? "desk", cycles, activeOn],
    queryFn: () => api<RealizedSummary>(
      `/realized?active_on=${activeOn}` +
      (cycles ? `&expiries=${encodeURIComponent(cycles)}` : "") +
      (accountId ? `&accounts=${encodeURIComponent(accountId)}` : "")
    ),
  });
  const realizedLegs = (realizedQuery.data?.legs ?? []).filter(
    leg => (leg.currency || "Unknown") === currency
  );
  /* Two separate costs, and they were conflated. `booked` is P&L the desk
     realised by closing something; `commission` is what every fill in the cycle
     cost, opening ones included. Netting commissions only into booked P&L meant
     the toggle did nothing at all on a book that had not been adjusted — which
     is most books, most of the time. */
  /* IBKR's average cost already carries the commission, moved against the
     trader: a buy costs more than it printed and a sale realises less. Verified
     to four decimals on the live book — 2155.00 + 1.6303 = 2156.6303 on a long,
     2473.00 − 1.1303 = 2471.8697 on a short. Every payoff figure derived from
     average cost is therefore already *net*, which is why this panel read
     11.04 worse than a tool that prices off the premium alone.

     So the toggle does the opposite of what it looks like: showing the payoff
     "without commissions" means adding back what the broker already took out. */
  const realizedCommission = realizedLegs.reduce((sum, leg) => sum + (numeric(leg.commission) ?? 0), 0);
  const booked = realizedLegs.reduce((sum, leg) => sum + (numeric(leg.realized_pnl) ?? 0), 0);
  /* Only fills that closed nothing: their commission is still embedded in the
     average cost of a leg being modelled. A closing fill's commission is
     already accounted for in the realized P&L the broker reports for it. */
  const openCommission = realizedLegs
    .filter(leg => (numeric(leg.realized_pnl) ?? 0) === 0)
    .reduce((sum, leg) => sum + (numeric(leg.commission) ?? 0), 0);
  const charged = withCommissions ? 0 : openCommission;
  /** Booked P&L actually applied, which is nothing when it is switched off. */
  const applied = withClosed ? booked : 0;
  const realized = applied + charged;
  const realizedByAccount: Record<string, number> = {};
  for (const leg of realizedLegs) {
    const amount =
      (withClosed ? (numeric(leg.realized_pnl) ?? 0) : 0) +
      (!withCommissions && (numeric(leg.realized_pnl) ?? 0) === 0 ? (numeric(leg.commission) ?? 0) : 0);
    if (amount) realizedByAccount[leg.account_id] = (realizedByAccount[leg.account_id] ?? 0) + amount;
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
  /* Paired to the columns the reader asked for, rather than filtered out of the
     curve: a column keeps its own heading — a percentage or a price — and the
     point behind it is looked up by the shock that column resolves to. */
  const byShock = new Map(adjusted.map(point => [round(point.shock), point]));
  const scenarioRows = columns
    .map(column => ({ column, point: byShock.get(round(column.shock)) }))
    .filter((entry): entry is { column: Column; point: (typeof adjusted)[number] } => !!entry.point);
  const currentPoint = adjusted.find(point => point.shock === 0);
  const openPoint = points.find(point => point.shock === 0);
  const accountIds = points.length ? Object.keys(points[0].accounts).sort() : [];
  /* Which accounts get a row of their own. Empty means all of them, so a desk
     that has never touched this control sees what it always saw. */
  const [shownAccounts, setShownAccounts] = useState<string[]>([]);
  const pickedAccounts = shownAccounts.filter(id => accountIds.includes(id));
  const accountRows = pickedAccounts.length ? pickedAccounts : accountIds;
  const toggleAccount = (id: string) =>
    setShownAccounts(current => {
      const shown = current.filter(a => accountIds.includes(a));
      const effective = shown.length ? shown : accountIds;
      const next = effective.includes(id) ? effective.filter(a => a !== id) : [...effective, id];
      // All of them is the same statement as none, and keeps the default clean.
      return next.length === accountIds.length ? [] : next;
    });
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
        {booked !== 0 && <label className="commission-toggle">
          <input type="checkbox" checked={withClosed} onChange={e => setWithClosed(e.target.checked)} />
          <span>Include closed legs</span>
          <small><Amount value={String(booked)} /> {currency} booked</small>
        </label>}
        {/* A magnitude, not a signed level: entering 7 adds both the −7% and
            the +7% column, because the move that helps and the one that hurts
            are the same question. */}
        <label className="custom-level">
          <span>Add scenario level (%)</span>
          <span className="level-entry">
            <input
              type="number" min="0.1" max="99" step="any" inputMode="decimal"
              placeholder="e.g. 7"
              aria-label="Add a custom scenario level, in percent"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addLevel(); } }}
            />
            {/* Outline, not ghost: a ghost button beside a text input reads as
                a label, and this one is the action that does the thing. */}
            <Button type="button" variant="outline" size="sm" onClick={addLevel} disabled={!canAdd}>
              <Plus size={14} aria-hidden="true" />Add
            </Button>
          </span>
          <small>
            {custom.length >= MAX_CUSTOM
              ? `At ${MAX_CUSTOM} custom levels — remove one to add another`
              : columns.some(column => column.custom)
                ? "Tap a level below to remove it"
                : `Adds a −x% and +x% column alongside ${RMS_SHOCKS.filter(s => s > 0).join(", ")}`}
          </small>
        </label>
        {/* A price the underlying might reach, rather than a move away from
            where it is. One column, and its percentage follows the reference. */}
        {keys.length === 1 && <label className="custom-level">
          <span>Add {keys[0].split(":").at(-1)} price level</span>
          <span className="level-entry">
            <input
              type="number" min="0.01" step="any" inputMode="decimal"
              placeholder={assumptions[keys[0]]?.spot > 0 ? money(String(assumptions[keys[0]].spot), 0) : "e.g. 7800"}
              aria-label="Add a scenario level at an absolute price"
              value={priceDraft}
              onChange={e => setPriceDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addPrice(); } }}
            />
            <Button type="button" variant="outline" size="sm" onClick={addPrice} disabled={!canAddPrice}>
              <Plus size={14} aria-hidden="true" />Add
            </Button>
          </span>
          <small>P&amp;L at that exact level, whatever the reference moves to</small>
        </label>}
        <div className="bar-row">
        {!accountId && accountIds.length > 0 && (
          <Dropdown
            label="Accounts"
            value={pickedAccounts.length ? `${pickedAccounts.length} of ${accountIds.length}` : `All ${accountIds.length}`}
          >
            <div className="dropdown-menu" role="group" aria-label="Accounts to show as rows">
              <button type="button" className="all" onClick={() => setShownAccounts([])} disabled={!pickedAccounts.length}>
                Show all
              </button>
              {accountIds.map(id => (
                <label key={id}>
                  <input type="checkbox" checked={accountRows.includes(id)} onChange={() => toggleAccount(id)} />
                  <span>{id}</span>
                </label>
              ))}
            </div>
          </Dropdown>
        )}
        {columns.some(column => column.custom) && <span className="level-chips" role="group" aria-label="Scenario columns">
          {columns.filter(column => column.custom && (column.shock > 0 || column.kind === "price")).map(column => (
            <button
              key={column.id}
              type="button"
              className={`${column.kind}${column.custom ? " custom" : ""}`}
              onClick={() => dropColumn(column)}
              aria-label={`Remove the ${column.kind === "price" ? column.label : `±${Math.abs(column.shock)}%`} scenario column`}
              title={`Remove ${column.kind === "price" ? column.label : `±${Math.abs(column.shock)}%`}`}
            >
              {column.kind === "price" ? column.label : `±${Math.abs(column.shock)}%`}
              <b aria-hidden="true">×</b>
            </button>
          ))}
        </span>}
        <label className="commission-toggle">
          <input type="checkbox" checked={withCommissions} onChange={e => setWithCommissions(e.target.checked)} />
          <span>Include commissions</span>
        </label>
        </div>
      </div>
      {missing.length > 0 && <p role="status">Enter valid assumptions for {missing.join(", ")} to calculate the curve.</p>}
      {excluded.length > 0 && <details><summary>Partial coverage: {excluded.length} excluded legs</summary><ul>{excluded.map(({ position: p, reason }) => <li key={`${p.account_id}:${p.con_id}`}>{p.account_id} · {positionLabel(p)}: {reason}</li>)}</ul></details>}
      {tails.length > 0 && <p className="risk-warning">Potential uncapped upside exposure: {tails.join(", ")}. Calls at different expiries are not treated as guaranteed hedges.</p>}
      {ready && <>
        {columns.some(column => column.custom) && <div className="level-legend">
          <span><i />Default levels</span>
          <span className="is-custom"><i />Added by you</span>
          {columns.some(column => column.kind === "price") && <span className="is-price"><i />Price level</span>}
        </div>}
        <div className="risk-table"><table className="scenario-grid"><caption>RMS by account ID · Scenario P&amp;L ({currency})
            {applied !== 0 && " · includes booked P&L from closed legs"}
            {charged !== 0 && " · gross of commissions"}
            {withCommissions && " · net of commissions"}</caption>
          {/* An explicit aria-label on each header keeps its accessible name the
              bare level — "+1%" — regardless of the move buttons inside it;
              without it their own labels ("Move +1% left") fold into the
              header's own name too, and a lookup by level stops matching. */}
          <thead><tr><th scope="col">Measure</th>{scenarioRows.map(({ column }, index) => (
            <th key={column.id} scope="col" className={cellClass(column)} aria-label={column.label}>
              <span className="col-head">
                {column.label}
                {scenarioRows.length > 1 && <span className="col-move">
                  <button type="button" aria-label={`Move ${column.label} left`}
                    disabled={index === 0} onClick={() => moveColumn(column.id, -1)}>‹</button>
                  <button type="button" aria-label={`Move ${column.label} right`}
                    disabled={index === scenarioRows.length - 1} onClick={() => moveColumn(column.id, 1)}>›</button>
                </span>}
              </span>
            </th>
          ))}</tr></thead>
          <tbody>
            <tr><th scope="row">Scenario underlying level</th>{scenarioRows.map(({ column, point }) => <td key={column.id} className={cellClass(column)}>{scenarioLevel(point.shock)}</td>)}</tr>
            {/* Two adjustments, and they are different things: P&L realised by
                closing a leg, and commission IBKR had folded into average cost.
                One row carrying their sum called the whole thing "booked P&L",
                which on a book with no closings labelled 11.04 of commission as
                something the desk had booked. */}
            {realized !== 0 && <>
              <tr><th scope="row">Open legs, as broker reports</th>{scenarioRows.map(({ column, point }) => <td key={column.id} className={cellClass(column)}><Amount value={String(point.terminal - realized)} /></td>)}</tr>
              {applied !== 0 && <tr className="booked"><th scope="row">Booked P&amp;L (closed legs)</th>{scenarioRows.map(({ column }) => <td key={column.id} className={cellClass(column)}><Amount value={String(applied)} /></td>)}</tr>}
              {charged !== 0 && <tr className="booked"><th scope="row">Commissions added back</th>{scenarioRows.map(({ column }) => <td key={column.id} className={cellClass(column)}><Amount value={String(charged)} /></td>)}</tr>}
            </>}
            <tr className="total"><th scope="row">{accountId ? accountId : "Desk total"} terminal</th>{scenarioRows.map(({ column, point }) => <td key={column.id} className={cellClass(column)}><Amount value={String(point.terminal)} /></td>)}</tr>
            <tr><th scope="row">Pre-expiry estimate</th>{scenarioRows.map(({ column, point }) => <td key={column.id} className={cellClass(column)}><Amount value={String(point.modeled)} /></td>)}</tr>
            {!accountId && accountRows.map(a => <tr key={a}><th scope="row">{a} terminal</th>{scenarioRows.map(({ column, point }) => <td key={column.id} className={cellClass(column)}><Amount value={String(point.accounts[a])} /></td>)}</tr>)}
          </tbody>
        </table></div>
        {/* Drives the whole panel, chart included: two expiries added together
            are two payoffs drawn on one axis, which is not a shape anyone
            trades. Sits above the curve it changes. */}
        <StrategyPayoff
          legs={legs} assumptions={assumptions} keys={keys} currency={currency}
          rate={rate} offset={realized} light={light} range={range}
          horizon={horizon}
          toolbar={<>{expiries.length > 0 && (
          <Dropdown
            className="expiry-picker"
            label="Expiry"
            value={picked.length ? `${picked.length} of ${expiries.length}` : (expiries.length === 1 ? (expiryDate(expiries[0]) || expiries[0]) : `All ${expiries.length}`)}
          >
            <div className="dropdown-menu" role="group" aria-label="Expiry cycles to model">
              <button type="button" className="all" onClick={() => setChosen([])} disabled={!picked.length}>
                Show all cycles
              </button>
              {expiries.map(value => (
                <label key={value}>
                  <input type="checkbox" checked={shown.includes(value)} onChange={() => toggleExpiry(value)} />
                  <span>{expiryDate(value) || value}</span>
                </label>
              ))}
            </div>
          </Dropdown>
        )}</>}
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
          {applied !== 0 && <span>Booked P&L from closed legs this cycle <b><Amount value={String(applied)} /> {currency}</b></span>}
          {charged !== 0 && <span>Commissions added back (IBKR bakes them into average cost) <b><Amount value={String(charged)} /> {currency}</b></span>}
          {realized !== 0 && <span>Open legs as the broker reports them, at current reference (0%) <b><Amount value={String(openPoint?.terminal)} /> {currency}</b></span>}
          <span>Expiry P&L if SPX expires at current reference (0%) <b><Amount value={String(currentPoint?.terminal)} /> {currency}</b></span>
          <span>Live marked P&L at current reference (0%) <b><Amount value={String(currentPoint?.modeled)} /> {currency}</b></span>
          {/* Named for the question each answers. "Worst mark-anchored estimate
              in sampled range" described its own method and left the reader to
              work out what it was for. */}
          <span>Worst case at expiry (max loss, within plotted range) <b><Amount value={String(Math.min(...adjusted.map(p => p.terminal)))} /> {currency}</b></span>
          <span>Worst case today if the market gapped (mark-to-market) <b><Amount value={String(Math.min(...adjusted.map(p => p.modeled)))} /> {currency}</b></span>
        </div>
        {booked !== 0 && !withClosed && <p className="footnote">Open legs only. <Amount value={String(booked)} /> {currency} of P&amp;L booked on closed legs this cycle is excluded — an adjustment that closed a strike at a loss and opened another leaves that loss out of the open positions entirely, so every figure here reads as though it never happened.</p>}
        {openCommission !== 0 && <p className="footnote">
          {withCommissions
            ? <>Net of commissions, as the broker reports it: IBKR builds the {money(String(openCommission))} {currency} paid on this cycle&rsquo;s fills into each leg&rsquo;s average cost, so every figure above already carries it.</>
            : <>Gross of commissions: the {money(String(openCommission))} {currency} IBKR embedded in average cost has been added back, so these figures price off the premium alone and match a tool that does the same. Tick the box to see what the broker actually charged.</>}
        </p>}
        {realized !== 0 && booked !== 0 && <p className="footnote">Booked P&amp;L covers {realizedLegs.filter(l => numeric(l.realized_pnl) !== 0).length} closed {realizedLegs.filter(l => numeric(l.realized_pnl) !== 0).length === 1 ? "leg" : "legs"} on the {[...new Set(realizedLegs.filter(l => numeric(l.realized_pnl) !== 0).map(l => l.expiry).filter(Boolean))].join(", ") || "live"} cycle — an adjustment that closes a strike at a loss and opens another leaves that loss out of the open positions entirely, so it is added back here as a constant. {withCommissions
            ? `Net of the ${money(String(realizedCommission))} ${currency} commission paid on those fills.`
            : `Gross of commissions; ${money(String(realizedCommission))} ${currency} of commission was paid on those fills, and is excluded above.`} Every figure above and in the table below includes it.</p>}
        <p className="footnote">The two worst-case figures answer different questions: the first is what this book can finally settle at, the second what it could mark at today before any time value has decayed — they peak at different prices, and the second is the one a margin call follows. Both are limited to the plotted range, so widening it can make either worse. The live marked value and today&rsquo;s estimates update with IBKR position marks over WebSocket. Expiry values change only when the scenario crosses a strike; a defined-risk strategy&rsquo;s worst terminal loss can remain fixed as SPX moves.</p>
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
