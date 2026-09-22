"use client";

import { memo, ReactNode, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Account, Position, RealizedSummary } from "@/lib/types";
import { ASSUMED_VOL, Assumption, brokerSpot, buildCurves, DEFAULT_DIV_YIELD, DEFAULT_RATE, impliedByUnderlying, numeric, prepareLegs, RMS_SHOCKS, spotLabel, underlyingKey, upsideRisks, validAssumption } from "@/lib/payoff";
import { buildRows, dominantKey, expiryLabel, expiryOf, Lens, LENSES, LensRow, NO_EXPIRY, realizedByGroup, ShockMode, unpricedPositions } from "@/lib/risk-lenses";
import { buildColumns, cellClass, Column, COLUMN_ORDER_KEY, CUSTOM_LEVELS_KEY, DEFAULT_LEVELS, isDefaultPct, levelLabel, MAX_CUSTOM, orderColumns, PRICE_LEVELS_KEY, round } from "@/lib/scenario-columns";
import { ChevronDown, ChevronUp, Plus, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Denomination, LensTable, TOTAL_ROW } from "./lens-table";
import { useSelection } from "./selection";
import { Segmented } from "./segmented";
import { ShockCurve } from "./shock-curve";
import { StrategyPayoff } from "./strategy-payoff";
import { SearchableSelect } from "./searchable-select";
import { SearchableMultiSelect } from "./searchable-multi-select";
import { Amount, money, positionLabel } from "./tables";
import { Term } from "./term";
import { useZone } from "./timezone";
import { todayIn } from "@/lib/timezone";
import { parseLevels, parsePrices, usePersisted, writeStored } from "@/lib/persisted";

export { buildColumns, COLUMN_ORDER_KEY, levelLabel, orderColumns } from "@/lib/scenario-columns";

const LENS_KEY = "rms.lens";
const SHOCK_KEY = "rms.shock";
const DENOMINATION_KEY = "rms.denomination";

const isLens = (value: string): value is Lens => LENSES.some(l => l.id === value);
const symbolOf = (key: string) => key.split(":").at(-1) ?? key;

function currencyRank(rows: Position[], at: number): string[] {
  const groups = new Map<string, Position[]>();
  for (const row of rows) {
    if (numeric(row.quantity) === 0) continue;
    const name = row.currency || "Unknown";
    const group = groups.get(name);
    if (group) group.push(row);
    else groups.set(name, [row]);
  }
  const score = (name: string) => {
    const group = groups.get(name) ?? [];
    const { legs } = prepareLegs(group, at);
    const priced = new Set(
      [...new Set(legs.map(leg => underlyingKey(leg.position)))].filter(key => brokerSpot(legs, key)),
    );
    return [legs.filter(leg => priced.has(underlyingKey(leg.position))).length, group.length] as const;
  };
  return [...groups.keys()].sort((left, right) => {
    const [modeledLeft, countLeft] = score(left);
    const [modeledRight, countRight] = score(right);
    return modeledRight - modeledLeft || countRight - countLeft || left.localeCompare(right);
  });
}

export const PayoffPanel = memo(function PayoffPanel({ rows, accounts = [], accountId, loading, error, light }: {
  rows: Position[];
  accounts?: Account[];
  accountId?: string;
  loading: boolean;
  error: boolean;
  light: boolean;
}) {
  const [currencyChoice, setCurrency] = useState("");
  const [overrides, setOverrides] = useState<Record<string, Partial<Assumption>>>({});
  const [range, setRange] = useState(10);
  const [withCommissions, setWithCommissions] = useState(false);
  const [withClosed, setWithClosed] = useState(true);
  const storedLens = usePersisted(LENS_KEY, "asset");
  const lens: Lens = isLens(storedLens) ? storedLens : "asset";
  const setLens = (next: Lens) => writeStored(LENS_KEY, next);
  const shockMode: ShockMode = usePersisted(SHOCK_KEY, "parallel") === "beta" ? "beta" : "parallel";
  const setShockMode = (next: ShockMode) => writeStored(SHOCK_KEY, next);
  const denomination: Denomination = usePersisted(DENOMINATION_KEY, "money") === "pct" ? "pct" : "money";
  const setDenomination = (next: Denomination) => writeStored(DENOMINATION_KEY, next);
  const custom = parseLevels(usePersisted(CUSTOM_LEVELS_KEY, DEFAULT_LEVELS));
  const prices = parsePrices(usePersisted(PRICE_LEVELS_KEY, ""));
  const [draft, setDraft] = useState("");
  const [priceDraft, setPriceDraft] = useState("");
  const [expandedChoice, setExpanded] = useState<Record<Lens, string | null | undefined>>({ asset: undefined, expiry: undefined, account: undefined });
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
  const currencies = currencyRank(rows, now);
  const currency = currencies.includes(currencyChoice) ? currencyChoice : currencies[0] ?? "";
  const scoped = rows.filter(p => (p.currency || "Unknown") === currency);
  const { legs: allLegs, excluded } = prepareLegs(scoped, now);

  // One filter, applied before any lens: accounts × underlyings × expiries.
  const accountIds = [...new Set(allLegs.map(l => l.position.account_id))].sort();
  const allKeys = [...new Set(allLegs.map(l => underlyingKey(l.position)))].sort();
  const expiries = [...new Set(allLegs.map(l => expiryOf(l.position)))].sort((a, b) => (a === NO_EXPIRY ? 1 : b === NO_EXPIRY ? -1 : a.localeCompare(b)));
  const accountChoice = useSelection(accountIds);
  const nameChoice = useSelection(allKeys);
  const cycleChoice = useSelection(expiries);
  const legs = allLegs.filter(l =>
    accountChoice.has(l.position.account_id) && nameChoice.has(underlyingKey(l.position)) && cycleChoice.has(expiryOf(l.position)),
  );
  const legCount = (predicate: (leg: (typeof allLegs)[number]) => boolean) => {
    const n = allLegs.filter(predicate).length;
    return `${n} ${n === 1 ? "leg" : "legs"}`;
  };

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
      beta: shockMode === "beta" ? overrides[key]?.beta ?? 1 : undefined,
    };
  }
  const pricedKeys = keys.filter(key => validAssumption(assumptions[key]));
  const missing = keys.filter(key => !pricedKeys.includes(key));
  const modeled = legs.filter(leg => pricedKeys.includes(underlyingKey(leg.position)));
  const legsPerKey = (key: string) => modeled.filter(leg => underlyingKey(leg.position) === key).length;
  const optionsPerKey = (key: string) => modeled.filter(leg => underlyingKey(leg.position) === key && leg.position.sec_type === "OPT").length;
  const benchmark = [...pricedKeys].sort((a, b) =>
    optionsPerKey(b) - optionsPerKey(a) || legsPerKey(b) - legsPerKey(a) || a.localeCompare(b),
  )[0];
  const maxDays = Math.min(365, ...modeled.filter(l => l.position.sec_type === "OPT").map(l => l.days));
  const horizon = Math.min(days, maxDays);
  const horizonLabel = Number.isFinite(maxDays)
    ? new Date(now + horizon * 86400000).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
    : `${horizon.toFixed(1)}d`;
  const ready = !loading && !error && modeled.length > 0;
  const priceLevels = pricedKeys.length === 1 ? prices : [];
  const naturalColumns = buildColumns(custom, priceLevels, assumptions[pricedKeys[0]]?.spot ?? 0);
  const columnOrder = usePersisted(COLUMN_ORDER_KEY, "").split(",").filter(Boolean);
  const columns = orderColumns(naturalColumns, columnOrder);
  const chipColumns = columns.filter(column =>
    (column.shock > 0 || column.kind === "price") && !isDefaultPct(column),
  );
  const moveColumn = (id: string, delta: -1 | 1) => {
    const ids = columns.map(column => column.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    writeStored(COLUMN_ORDER_KEY, ids.join(","));
  };
  const levels = columns.map(column => column.shock);
  const points = ready ? buildCurves(modeled, assumptions, range, horizon, rate / 100, levels) : [];
  const tails = upsideRisks(modeled);
  const activeOn = todayIn("ET", now).replace(/-/g, "");
  const pickedCycles = cycleChoice.isAll ? [] : cycleChoice.selected.filter(value => value !== NO_EXPIRY);
  const cycles = pickedCycles.join(",");
  const realizedQuery = useQuery({
    queryKey: ["realized", accountId ?? "desk", cycles, activeOn],
    queryFn: () => api<RealizedSummary>(
      `/realized?active_on=${activeOn}` +
      (cycles ? `&expiries=${encodeURIComponent(cycles)}` : "") +
      (accountId ? `&accounts=${encodeURIComponent(accountId)}` : "")
    ),
  });
  const realizedLegs = (realizedQuery.data?.legs ?? []).filter(leg =>
    (leg.currency || "Unknown") === currency &&
    (accountChoice.isAll || accountChoice.has(leg.account_id)) &&
    (nameChoice.isAll || !leg.underlying || nameChoice.has(`${currency}:${leg.underlying}`)),
  );

  const realizedCommission = realizedLegs.reduce((sum, leg) => sum + (numeric(leg.commission) ?? 0), 0);
  const booked = realizedLegs.reduce((sum, leg) => sum + (numeric(leg.realized_pnl) ?? 0), 0);
  const openCommission = realizedLegs
    .filter(leg => (numeric(leg.realized_pnl) ?? 0) === 0)
    .reduce((sum, leg) => sum + (numeric(leg.commission) ?? 0), 0);
  const charged = withCommissions ? 0 : openCommission;
  const applied = withClosed ? booked : 0;
  const realized = applied + charged;
  const adjusted = realized === 0 ? points : points.map(point => ({
    ...point,
    terminal: point.terminal + realized,
    modeled: point.modeled + realized,
  }));
  const change = (key: string, field: keyof Assumption, value: string) => setOverrides(prev => {
    const next = { ...prev[key] };
    if (value.trim() === "" && (field === "spot" || field === "beta")) delete next[field];
    else next[field] = value.trim() === "" ? NaN : Number(value) / (field === "spot" || field === "beta" ? 1 : 100);
    return { ...prev, [key]: next };
  });
  const [inputs, setInputs] = useState(false);
  const [sheet, setSheet] = useState(false);
  const currentPoint = adjusted.find(point => point.shock === 0);
  const openPoint = points.find(point => point.shock === 0);

  // Net liquidation is only a valid denominator in the account's own currency.
  const nlv: Record<string, number | null> = {};
  for (const account of accounts) {
    nlv[account.account_id] = account.currency === currency ? numeric(account.net_liquidation) : null;
  }
  const lensRows = ready
    ? buildRows(lens, modeled, assumptions, {
        range, horizon, rate: rate / 100, levels, now,
        adjustments: realizedByGroup(lens, realizedLegs, withClosed, withCommissions),
        nlv,
      })
    : [];
  const totalNlvs = accountChoice.selected.map(id => nlv[id] ?? null);
  const total: LensRow = {
    id: TOTAL_ROW,
    label: accountId ? accountId : "Desk total",
    legs: modeled,
    keys: pricedKeys,
    accounts: accountChoice.selected,
    expiries: [...new Set(modeled.map(l => expiryOf(l.position)))],
    reference: pricedKeys.length === 1 ? marks[pricedKeys[0]] : undefined,
    now: currentPoint?.modeled ?? NaN,
    at: Object.fromEntries(adjusted.map(p => [p.shock, p.terminal])),
    estimate: Object.fromEntries(adjusted.map(p => [p.shock, p.modeled])),
    worst: adjusted.length ? Math.min(...adjusted.map(p => p.terminal)) : NaN,
    spark: adjusted.map(p => p.terminal),
    adjustment: realized,
    nlv: totalNlvs.length && totalNlvs.every(v => v !== null && v > 0) ? totalNlvs.reduce<number>((s, v) => s + (v ?? 0), 0) : null,
  };
  const openByShock: Record<number, number> = Object.fromEntries(points.map(p => [p.shock, p.terminal]));
  const dominant = dominantKey(lensRows);
  const defaultExpanded = lens === "asset"
    ? dominant ?? null
    : lensRows[0]?.id ?? null;
  const requested = expandedChoice[lens] === undefined ? defaultExpanded : expandedChoice[lens];
  const expanded = requested && (requested === TOTAL_ROW || lensRows.some(row => row.id === requested))
    ? requested
    : null;
  const setExpandedFor = (id: string | null) => setExpanded(prev => ({ ...prev, [lens]: id }));

  const levelFor = (shock: number): ReactNode => {
    const parts = pricedKeys.map(key => ({ symbol: symbolOf(key), price: money(String(assumptions[key].spot * (1 + shock * (assumptions[key].beta ?? 1) / 100))) }));
    if (parts.length <= 2) return parts.map(p => `${p.symbol} ${p.price}`).join(" · ");
    return (
      <Term hint={<span className="level-list">{parts.map(p => <span key={p.symbol}><span>{p.symbol}</span><b>{p.price}</b></span>)}</span>}>
        {parts.length} names
      </Term>
    );
  };

  const renderDetail = (row: LensRow | null): ReactNode => {
    const rowLegs = row ? row.legs : modeled;
    const rowKeys = (row ? row.keys : pricedKeys).filter(key => pricedKeys.includes(key));
    const offset = row ? row.adjustment : realized;
    const chart = rowKeys.length === 1
      ? <StrategyPayoff legs={rowLegs} assumptions={assumptions} keys={rowKeys} currency={currency}
          rate={rate} offset={offset} light={light} range={range} horizon={horizon} />
      : <>
          <ShockCurve
            currency={currency} light={light}
            betaSymbol={shockMode === "beta" && benchmark ? symbolOf(benchmark) : undefined}
            points={buildCurves(rowLegs, assumptions, range, horizon, rate / 100, levels).map(p => ({
              shock: p.shock, terminal: p.terminal + offset, modeled: p.modeled + offset,
            }))}
          />
          <ul className="detail-names" aria-label="Underlyings in this group">
            {rowKeys.map(key => (
              <li key={key}>
                <span className="ticker">{symbolOf(key)}</span>
                <b>{money(String(assumptions[key].spot))}</b>
                {shockMode === "beta" && <small>β {(assumptions[key].beta ?? 1).toFixed(2)}</small>}
              </li>
            ))}
          </ul>
        </>;
    return (
      <div className="lens-detail">
        {chart}
        <details className="detail-legs">
          <summary>{rowLegs.length} {rowLegs.length === 1 ? "leg" : "legs"} in this {row ? LENSES.find(l => l.id === lens)?.noun : "selection"}</summary>
          <ul>
            {rowLegs.map(leg => (
              <li key={`${leg.position.account_id}:${leg.position.con_id}`}>
                <span className="acct">{leg.position.account_id}</span>
                <span className="name">{positionLabel(leg.position)}</span>
                <span className={`qty ${leg.quantity < 0 ? "negative" : "positive"}`}>{leg.quantity > 0 ? "+" : ""}{leg.quantity}</span>
                <span className="num" title="Average cost">{money(leg.position.average_cost)}</span>
                <span className="num" title="Broker mark">{money(leg.position.market_price)}</span>
              </li>
            ))}
          </ul>
        </details>
      </div>
    );
  };

  const captionNotes = [
    ...(applied !== 0 ? ["includes booked P&L from closed legs"] : []),
    ...(charged !== 0 ? ["gross of commissions"] : []),
    ...(withCommissions ? ["net of commissions"] : []),
    ...(shockMode === "beta" && benchmark ? [`moves scaled by β to ${symbolOf(benchmark)}`] : []),
    ...(denomination === "pct" ? ["as % of net liquidation"] : []),
  ];

  const filters = (
    <div className="lens-filters" role="group" aria-label="Filters">
      {!accountId && accountIds.length > 0 && (
        <SearchableMultiSelect label="Accounts" selection={accountChoice} noun="accounts"
          describe={id => legCount(l => l.position.account_id === id)} />
      )}
      {allKeys.length > 0 && (
        <SearchableMultiSelect label="Underlyings" selection={nameChoice} noun="underlyings" searchFrom={2} format={symbolOf}
          describe={key => legCount(l => underlyingKey(l.position) === key)} />
      )}
      {expiries.length > 0 && (
        <SearchableMultiSelect label="Expiry" className="expiry-picker" selection={cycleChoice} noun="cycles" searchFrom={2} format={expiryLabel}
          describe={value => legCount(l => expiryOf(l.position) === value)} />
      )}
    </div>
  );

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
      <p className="footnote">{modeled.length} included legs · {excluded.length} excluded legs in {currency}. Model clock: {today} ({zone}); time to expiry runs to the 16:00 New York close, and the horizon stops at the earliest included expiry. Reference prices come from the broker: a held stock’s mark, else the underlying price IB computes for the options on it. Volatility defaults to an assumed 30%. Beta scales each name’s move against the benchmark when the beta-weighted shock is on; it defaults to 1.</p>
      {keys.length > 0 && <div className="risk-assumptions">{keys.map(key => <fieldset key={key}>
        <legend>{key}</legend>
        <label>Volatility (%)<input type="number" min="0" max="500" step="any" value={Number.isFinite(assumptions[key].volatility) ? assumptions[key].volatility * 100 : ""} onChange={e => change(key, "volatility", e.target.value)} /></label>
        <label>Dividend yield (%)<input type="number" min="0" max="100" step="any" value={Number.isFinite(assumptions[key].dividend) ? assumptions[key].dividend * 100 : ""} onChange={e => change(key, "dividend", e.target.value)} /></label>
        <label>Beta<input type="number" min="-5" max="5" step="0.05" placeholder="1" value={overrides[key]?.beta ?? ""} onChange={e => change(key, "beta", e.target.value)} /></label>
      </fieldset>)}</div>}
      </div>

      <div className="lens-bar">
        <Segmented<Lens>
          label="Lens"
          value={lens}
          onChange={setLens}
          options={LENSES.map(item => ({
            id: item.id,
            label: item.label,
            count: item.id === "asset" ? pricedKeys.length : item.id === "expiry" ? new Set(modeled.map(l => expiryOf(l.position))).size : new Set(modeled.map(l => l.position.account_id)).size,
            title: `Group the same legs by ${item.noun}`,
          }))}
        />
        <Button type="button" variant="outline" size="sm" className="filter-sheet-open"
          aria-expanded={sheet} aria-controls="filter-sheet"
          onClick={() => setSheet(true)}>
          Filters
        </Button>
        {filters}
        <div className="lens-modes">
          {currencies.length > 1 && currencies.length <= 4 && (
            <Segmented label="Currency" size="sm" value={currency} onChange={setCurrency}
              options={currencies.map(code => ({ id: code, label: code }))} />
          )}
          {pricedKeys.length > 1 && (
            <Segmented<ShockMode> label="Shock model" size="sm" value={shockMode} onChange={setShockMode}
              options={[
                { id: "parallel", label: "Parallel", title: "Every underlying moves by the column's percentage" },
                { id: "beta", label: `vs ${symbolOf(benchmark ?? "")} β`, title: `The column is a move in ${symbolOf(benchmark ?? "")}; each name moves by its beta times that` },
              ]} />
          )}
          {lens === "account" && (
            <Segmented<Denomination> label="Denomination" size="sm" value={denomination} onChange={setDenomination}
              options={[
                { id: "money", label: currency },
                { id: "pct", label: "% of NLV", title: "Each figure as a share of the account's net liquidation" },
              ]} />
          )}
        </div>
      </div>
      {sheet && (
        <div className="filter-sheet-backdrop" onClick={() => setSheet(false)}>
          <div id="filter-sheet" className="filter-sheet" role="dialog" aria-label="Filters"
            onClick={event => event.stopPropagation()}>
            {filters}
            <Button type="button" size="sm" onClick={() => setSheet(false)}>Done</Button>
          </div>
        </div>
      )}

      {ready && <div className="risk-metrics" aria-label="Summary">
        <span>
          <Term hint="What the selected legs mark at right now, at the broker reference, including any booked adjustments.">Marked now</Term>
          <b><Amount value={String(currentPoint?.modeled)} /> <small>{currency}</small></b>
        </span>
        <span>
          <Term hint={`Terminal P&L if every underlying expires exactly at its reference price${pricedKeys.length === 1 ? ` (${symbolOf(pricedKeys[0])} ${money(String(assumptions[pricedKeys[0]].spot))})` : ""}.`}>At expiry, unchanged</Term>
          <b><Amount value={String(currentPoint?.terminal)} /> <small>{currency}</small></b>
        </span>
        <span>
          <Term hint="Lowest terminal P&L anywhere in the plotted range — what this book can finally settle at. Widening the range can make it worse.">Worst at expiry</Term>
          <b><Amount value={String(total.worst)} /> <small>{currency}</small></b>
        </span>
        <span>
          <Term hint="Lowest mark-to-market anywhere in the plotted range if the market gapped today, before time value decays. This is the figure a margin call follows.">Worst mark today</Term>
          <b><Amount value={String(Math.min(...adjusted.map(p => p.modeled)))} /> <small>{currency}</small></b>
        </span>
        {pricedKeys.map(key => <span key={key} className="ref-metric">{key} reference <b>{money(String(assumptions[key].spot))}</b></span>)}
        {applied !== 0 && <span>Booked P&L from closed legs this cycle <b><Amount value={String(applied)} /> {currency}</b></span>}
        {charged !== 0 && <span>Commissions added back (IBKR bakes them into average cost) <b><Amount value={String(charged)} /> {currency}</b></span>}
        {realized !== 0 && <span>Open legs as the broker reports them, at current reference (0%) <b><Amount value={String(openPoint?.terminal)} /> {currency}</b></span>}
      </div>}

      <div className="reference-bar">
        {keys.map(key => {
          const symbol = symbolOf(key);
          const price = quoted[key];
          const priced = pricedKeys.includes(key);
          return <div key={key} className={`reference-card${priced ? "" : " unpriced"}`}>
            <div className="reference-readout">
              <span id={`ref-${key.replace(/:/g, "-")}`}>{symbol} reference price</span>
              <output className="reference-value" aria-labelledby={`ref-${key.replace(/:/g, "-")}`}>
                {price === undefined ? "—" : money(String(price))}
              </output>
              <small>{price === undefined ? "No broker mark" : spotLabel(marks[key]?.source ?? "")}</small>
            </div>
            {priced && <label className="iv-control">
              <span>{symbol} IV {(assumptions[key].volatility * 100).toFixed(1)}%</span>
              <input type="range" min={1} max={150} step={0.5}
                aria-label={`${symbol} implied volatility`}
                value={Number.isFinite(assumptions[key].volatility) ? assumptions[key].volatility * 100 : ASSUMED_VOL * 100}
                onChange={e => change(key, "volatility", e.target.value)} />
              <small>{overrides[key]?.volatility !== undefined
                ? `Manual · market ${((marketVol[key] ?? ASSUMED_VOL) * 100).toFixed(1)}%`
                : marketVol[key] === undefined ? "No invertible marks — assumed" : "From broker option marks"}</small>
            </label>}
            {priced && shockMode === "beta" && <label className="beta-control">
              <span>β to {symbolOf(benchmark ?? "")}</span>
              <input type="number" min="-5" max="5" step="0.05" inputMode="decimal" placeholder="1"
                aria-label={`${symbol} beta`}
                value={overrides[key]?.beta ?? ""}
                onChange={e => change(key, "beta", e.target.value)} />
            </label>}
          </div>;
        })}
      </div>

      <div className="scenario-bar">
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
            <Button type="button" variant="outline" size="sm" onClick={addLevel} disabled={!canAdd}>
              <Plus size={14} aria-hidden="true" />Add
            </Button>
          </span>
          <small>
            {custom.length >= MAX_CUSTOM
              ? `At ${MAX_CUSTOM} custom levels — remove one to add another`
              : columns.some(column => column.custom)
                ? "Tap a level to remove it"
                : `Adds a −x% and +x% column alongside ${RMS_SHOCKS.filter(s => s > 0).join(", ")}`}
          </small>
        </label>
        {pricedKeys.length === 1 && <label className="custom-level">
          <span>Add {symbolOf(pricedKeys[0])} price level</span>
          <span className="level-entry">
            <input
              type="number" min="0.01" step="any" inputMode="decimal"
              placeholder={assumptions[pricedKeys[0]]?.spot > 0 ? money(String(assumptions[pricedKeys[0]].spot), 0) : "e.g. 7800"}
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
          {chipColumns.length > 0 && <span className="level-chips" role="group" aria-label="Scenario columns">
            {chipColumns.map(column => (
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
          {booked !== 0 && <label className="commission-toggle">
            <input type="checkbox" checked={withClosed} onChange={e => setWithClosed(e.target.checked)} />
            <span>Include closed legs</span>
            <small><Amount value={String(booked)} /> {currency} booked</small>
          </label>}
        </div>
      </div>

      {(cycleChoice.isNone || accountChoice.isNone || nameChoice.isNone) && <div className="empty-selection" role="status">
        <span>Nothing selected in {[cycleChoice.isNone && "expiries", accountChoice.isNone && "accounts", nameChoice.isNone && "underlyings"].filter(Boolean).join(", ")} — {cycleChoice.isNone ? "No expiry cycles selected — tick a cycle or select all to model the book." : "tick an item or select all to model the book."}</span>
      </div>}
      {missing.length > 0 && lens !== "asset" && <p role="status">{modeled.length
        ? `Left out — no broker reference price for ${missing.join(", ")}.`
        : `No broker reference price for ${missing.join(", ")}, so nothing in this currency can be modeled.`}</p>}
      {missing.length > 0 && lens === "asset" && !modeled.length && <p role="status">No broker reference price for {missing.join(", ")}, so nothing in this currency can be modeled.</p>}
      {excluded.length > 0 && <details><summary>Partial coverage: {excluded.length} excluded legs</summary><ul>{excluded.map(({ position: p, reason }) => <li key={`${p.account_id}:${p.con_id}`}>{p.account_id} · {positionLabel(p)}: {reason}</li>)}</ul></details>}
      {tails.length > 0 && <p className="risk-warning">Potential uncapped upside exposure: {tails.join(", ")}. Calls at different expiries are not treated as guaranteed hedges.</p>}
      {ready && <>
        {columns.some(column => column.custom) && <div className="level-legend">
          <span><i />Default levels</span>
          <span className="is-custom"><i />Added by you</span>
          {columns.some(column => column.kind === "price") && <span className="is-price"><i />Price level</span>}
        </div>}
        <LensTable
          lens={lens}
          currency={currency}
          columns={columns}
          rows={lensRows}
          total={total}
          totalLabel={total.label}
          realized={{ open: openByShock, booked: applied, charged }}
          showLevelRow={lens !== "asset" || pricedKeys.length === 1}
          levelFor={levelFor}
          expanded={expanded}
          onExpand={setExpandedFor}
          moveColumn={moveColumn}
          denomination={lens === "account" ? denomination : "money"}
          unpriced={unpricedPositions(scoped.filter(p => accountChoice.has(p.account_id) && cycleChoice.has(expiryOf(p)) && nameChoice.has(underlyingKey(p))), currency, assumptions)}
          renderDetail={renderDetail}
          captionNotes={captionNotes}
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
        <p className="footnote">Rows open inline: one name shows its payoff against its own price with the strikes held; a group of names shows P&amp;L against the scenario move. Zoom a payoff graph by scrolling or pinching on the plot, or drag the bar below it. The shaded bell is the probability of each level at expiry under the IV above, not a forecast.</p>
        {booked !== 0 && !withClosed && <p className="footnote">Open legs only. <Amount value={String(booked)} /> {currency} of P&amp;L booked on closed legs this cycle is excluded — an adjustment that closed a strike at a loss and opened another leaves that loss out of the open positions entirely, so every figure here reads as though it never happened.</p>}
        {openCommission !== 0 && <p className="footnote">
          {withCommissions
            ? <>Net of commissions, as the broker reports it: IBKR builds the {money(String(openCommission))} {currency} paid on this cycle&rsquo;s fills into each leg&rsquo;s average cost, so every figure above already carries it.</>
            : <>Gross of commissions: the {money(String(openCommission))} {currency} IBKR embedded in average cost has been added back, so these figures price off the premium alone and match a tool that does the same. Tick the box to see what the broker actually charged.</>}
        </p>}
        {realized !== 0 && booked !== 0 && <p className="footnote">Booked P&amp;L covers {realizedLegs.filter(l => numeric(l.realized_pnl) !== 0).length} closed {realizedLegs.filter(l => numeric(l.realized_pnl) !== 0).length === 1 ? "leg" : "legs"} on the {[...new Set(realizedLegs.filter(l => numeric(l.realized_pnl) !== 0).map(l => l.expiry).filter(Boolean))].join(", ") || "live"} cycle — an adjustment that closes a strike at a loss and opens another leaves that loss out of the open positions entirely, so it is added back here as a constant. {withCommissions
            ? `Net of the ${money(String(realizedCommission))} ${currency} commission paid on those fills.`
            : `Gross of commissions; ${money(String(realizedCommission))} ${currency} of commission was paid on those fills, and is excluded above.`} Every figure above and in the table includes it, attributed to the row it was booked on.</p>}
        <p className="footnote">The two worst-case figures answer different questions: the first is what this book can finally settle at, the second what it could mark at today before any time value has decayed — they peak at different prices, and the second is the one a margin call follows. Both are limited to the plotted range, so widening it can make either worse. Live marked values update with IBKR position marks over WebSocket. Expiry values change only when the scenario crosses a strike; a defined-risk strategy&rsquo;s worst terminal loss can remain fixed as the market moves.</p>
      </>}
      <p className="footnote">Terminal payoff applies the same percentage move to every underlying — or its beta multiple, when the beta-weighted shock is on — at each option’s own expiry; mixed expiries do not represent a single-date liquidation. Pre-expiry estimates use European Black–Scholes with constant assumed volatility and dividend yield. Early exercise, assignment, volatility skew, fees and cash flows are not modeled. Stocks and standard stock options only; adjusted contracts cannot be identified from this feed. Grouping assumes the same symbol and currency identify the same underlying. These are hypothetical scenarios, not broker marks or a maximum-loss guarantee.</p>
    </>}
  </section>;
}, (previous, next) => previous.accountId === next.accountId && previous.loading === next.loading && previous.error === next.error && previous.light === next.light
  && (previous.accounts?.length ?? 0) === (next.accounts?.length ?? 0)
  && (previous.accounts ?? []).every((account, index) => {
    const incoming = next.accounts?.[index];
    return !!incoming && account.account_id === incoming.account_id && account.currency === incoming.currency && account.net_liquidation === incoming.net_liquidation;
  })
  && previous.rows.length === next.rows.length && previous.rows.every((row, index) => {
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
