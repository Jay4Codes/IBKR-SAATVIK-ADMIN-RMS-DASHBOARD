"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Decimal from "decimal.js";
import { api } from "@/lib/api";
import { Account, DailyPnlResponse, IntradayResponse } from "@/lib/types";
import { HISTORY_START, PERIODS, Period, sinceDays } from "@/lib/history";
import { formatDateTime, todayIn, ZONES, ZoneId, zoneOf } from "@/lib/timezone";
import { Chart } from "./chart";
import { SelectionActions, summarizeChoices, useSelection } from "./selection";
import { money } from "./tables";
import { useZone } from "./timezone";
import { useAccountNames } from "./account-names";
import { ChartSkeleton } from "./skeleton";
import { SearchableMultiSelect } from "./searchable-multi-select";

type Mode = "combined" | "accounts";
type Standing = { id: string; value: number | null; at: string | null; stale: boolean };

const HIGHLIGHT = ["#6f8cff", "#f0a43c", "#4fc6cf", "#e06fd0", "#b8d84a"];
const TOP_MOVERS = HIGHLIGHT.length;

const hhmm = (ms: number, zone: ZoneId) =>
  new Date(ms).toLocaleTimeString(undefined, { timeZone: zoneOf(zone), hour: "2-digit", minute: "2-digit", hour12: false });

const compact = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return v.toFixed(0);
};

export function DayPnlPanel({ accountId, accounts }: { accountId?: string; accounts: string[] }) {
  const zone = useZone();
  const { name } = useAccountNames();
  const choice = useSelection(accounts);
  const scope = accountId ? [accountId] : choice.selected;
  const date = todayIn(zone);
  const desk = !accountId && accounts.length > 1;
  const [mode, setMode] = useState<Mode>("combined");
  const [focus, setFocus] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("day");
  const daily = period !== "day";
  const periodDays = PERIODS.find((p) => p.id === period)?.days ?? 0;
  const from = daily ? sinceDays(periodDays) : date;

  const assetList = useQuery({
    queryKey: ["pnl-assets", scope.join(",")],
    queryFn: () => api<string[]>(`/history/assets?accounts=${encodeURIComponent(scope.join(","))}`),
    enabled: scope.length > 0,
    staleTime: 60_000,
  });
  const assetChoice = useSelection(assetList.data ?? []);
  /** Every asset ticked means the broker's own account figure; a subset sums those assets' legs. */
  const assetFilter = assetChoice.isAll ? "" : assetChoice.selected.join(",");
  const noAssets = assetChoice.isNone;
  const assetParam = assetFilter ? `&assets=${encodeURIComponent(assetFilter)}` : "";

  const intraday = useQuery({
    queryKey: ["intraday", scope.join(","), date, assetFilter],
    queryFn: () =>
      api<IntradayResponse>(
        `/history/intraday?accounts=${encodeURIComponent(scope.join(","))}&date=${date}${assetParam}`,
      ),
    enabled: scope.length > 0 && !daily && !noAssets,
  });
  const history = useQuery({
    queryKey: ["daily-pnl", scope.join(","), from, assetFilter],
    queryFn: () =>
      api<DailyPnlResponse>(
        `/history/pnl?accounts=${encodeURIComponent(scope.join(","))}&since=${from}${assetParam}`,
      ),
    enabled: scope.length > 0 && daily && !noAssets,
  });

  const liveAccounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/accounts"),
    enabled: !daily && !assetFilter,
  });
  const liveById = new Map((liveAccounts.data ?? []).map((account) => [account.account_id, account]));
  const liveStandings = !daily && !assetFilter;

  const series = intraday.data?.series ?? [];
  const combined = intraday.data?.combined ?? [];
  const unreported = new Set(intraday.data?.unreported ?? []);
  const dailySeries = history.data?.series ?? [];
  const dailyCombined = history.data?.combined ?? [];
  const perAccount = [...new Set((daily ? dailySeries : series).map((r) => r.account_id))].sort();
  const stamps = [...new Set(series.map((r) => r.taken_at))].sort();
  const days = [...new Set(dailySeries.map((r) => r.report_date))].sort();
  const zoneLabel = ZONES.find((z) => z.id === zone)?.id ?? zone;
  const currency = (daily ? dailySeries : series)[0]?.currency || "";
  const lastStamp = stamps[stamps.length - 1] ?? null;
  const periodLabel = PERIODS.find((p) => p.id === period)?.label ?? "Day";

  const extendLive = (points: [number, number][], at: number, value: number | null) => {
    if (value == null || !Number.isFinite(at) || at <= 0) return points;
    const last = points[points.length - 1];
    if (last && at <= last[0]) return [...points.slice(0, -1), [last[0], value] as [number, number]];
    return [...points, [at, value] as [number, number]];
  };
  const pointsFor = (id: string) => {
    const history = series
      .filter((r) => r.account_id === id && r.day_pnl != null)
      .map((r) => [Date.parse(r.taken_at), Number(r.day_pnl)] as [number, number]);
    if (!liveStandings) return history;
    const account = liveById.get(id);
    return extendLive(history, Date.parse(account?.updated_at ?? ""), account?.day_pnl != null ? Number(account.day_pnl) : null);
  };
  const liveReported = liveStandings ? scope.filter((id) => liveById.get(id)?.day_pnl != null) : [];
  const liveTotal = liveReported.length
    ? liveReported.reduce((sum, id) => sum + Number(liveById.get(id)!.day_pnl), 0)
    : null;
  const liveAt = liveReported.reduce((at, id) => Math.max(at, Date.parse(liveById.get(id)?.updated_at ?? "") || 0), 0);
  const cumulativeFor = (id: string) => {
    let running = 0;
    const byDate = new Map(dailySeries.filter((r) => r.account_id === id).map((r) => [r.report_date, Number(r.day_pnl)]));
    return days.map((d) => {
      running += byDate.get(d) ?? 0;
      return [d, running] as [string, number];
    });
  };

  const standings: Standing[] = (liveStandings ? scope : perAccount)
    .map((id) => {
      if (liveStandings) {
        const account = liveById.get(id);
        return {
          id,
          value: account?.day_pnl != null ? Number(account.day_pnl) : null,
          at: account?.updated_at ?? null,
          stale: false,
        };
      }
      if (daily) {
        const rows = dailySeries.filter((r) => r.account_id === id);
        return {
          id,
          value: rows.length ? rows.reduce((sum, r) => sum + Number(r.day_pnl), 0) : null,
          at: rows[rows.length - 1]?.taken_at ?? null,
          stale: rows.length > 0 && rows[rows.length - 1].report_date !== days[days.length - 1],
        };
      }
      const rows = series.filter((r) => r.account_id === id);
      const valued = [...rows].reverse().find((r) => r.day_pnl != null);
      return {
        id,
        value: valued ? Number(valued.day_pnl) : null,
        at: valued?.taken_at ?? null,
        stale: !!valued && rows[rows.length - 1]?.day_pnl == null,
      };
    })
    .sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  const valued = standings.filter((s) => s.value !== null);
  const movers = [...valued].sort((a, b) => Math.abs(b.value!) - Math.abs(a.value!)).slice(0, TOP_MOVERS).map((s) => s.id);
  const colorOf = (id: string) => {
    const i = movers.indexOf(id);
    return i >= 0 ? HIGHLIGHT[i] : null;
  };

  const latestCombined = combined[combined.length - 1];
  const latestDaily = dailyCombined[dailyCombined.length - 1];
  const latest = (() => {
    if (daily) return latestDaily ? new Decimal(latestDaily.cumulative) : null;
    if (liveTotal != null) return new Decimal(liveTotal);
    if (desk || (!accountId && combined.length)) return latestCombined ? new Decimal(latestCombined.day_pnl) : null;
    const v = valued[0]?.value;
    return v == null ? null : new Decimal(v);
  })();
  const showCombined = desk ? mode === "combined" : false;
  const scale = Math.max(1, ...valued.map((s) => Math.abs(s.value!)));

  return (
    <section className="panel day-pnl">
      <h2>
        {daily ? `${periodLabel} P&L` : "Day P&L"}
        <span>
          {daily ? `${from} → ${date}` : `${date} · ${zoneLabel}`}
          {latest && (
            <>
              {" · "}
              <b className={latest.isNegative() ? "negative" : "positive"}>
                {latest.isNegative() ? "" : "+"}
                {money(latest.toString())} {currency}
              </b>
            </>
          )}
        </span>
      </h2>

      <div className="day-pnl-toolbar">
        <div className="segmented sm" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={period === p.id ? "on" : ""}
              aria-pressed={period === p.id}
              onClick={() => setPeriod(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
        {!accountId && accounts.length > 1 && !daily && (
          <div className="segmented sm" role="group" aria-label="Chart view">
            <button type="button" className={mode === "combined" ? "on" : ""} aria-pressed={mode === "combined"} onClick={() => setMode("combined")}>
              Combined
            </button>
            <button type="button" className={mode === "accounts" ? "on" : ""} aria-pressed={mode === "accounts"} onClick={() => setMode("accounts")}>
              By account <small>{perAccount.length}</small>
            </button>
          </div>
        )}
        {!accountId && accounts.length > 1 && (
          <details className="day-pnl-accounts">
            <summary>Accounts · {summarizeChoices(choice.selected.map(name))}</summary>
            <fieldset className="account-picker">
              <legend>Accounts in this view</legend>
              <SelectionActions selection={choice} noun="accounts" />
              {accounts.map((id) => (
                <label key={id}>
                  <input type="checkbox" checked={choice.has(id)} onChange={() => choice.toggle(id)} />
                  {name(id)}
                </label>
              ))}
            </fieldset>
          </details>
        )}
        {assetChoice.options.length > 0 && (
          <SearchableMultiSelect
            label="Assets"
            noun="assets"
            selection={assetChoice}
            searchFrom={2}
            className="day-pnl-assets"
          />
        )}
      </div>

      {!scope.length ? (
        <p role="status" className="footnote">No accounts selected. Open Accounts above and tick one to draw its P&amp;L.</p>
      ) : noAssets ? (
        <p role="status" className="footnote">No assets selected. Open Assets above and tick one to draw its P&amp;L.</p>
      ) : daily && history.isPending ? (
        <ChartSkeleton label={`Loading ${periodLabel.toLowerCase()} P&L`} height={300} />
      ) : daily && history.isError ? (
        <p role="alert" className="footnote">{periodLabel} P&amp;L could not be loaded.</p>
      ) : daily && !days.length ? (
        <p className="footnote">
          No trading days recorded since {from} for{" "}
          {assetFilter ? `${assetChoice.selected.join(", ")} in these accounts` : "these accounts"}.
        </p>
      ) : daily ? (
        <div className={desk ? "day-pnl-body" : undefined}>
          <Chart
            height={320}
            ariaLabel={`${periodLabel} profit and loss from ${from} to ${date} for ${scope.join(", ")}`}
            unavailable="Chart unavailable."
            deps={[days.join(","), perAccount.join(","), dailyCombined.length, mode, focus, desk, period]}
            option={(t, zoom) => {
              const showAccounts = desk && mode === "accounts";
              const byDay = new Map(dailyCombined.map((r) => [r.report_date, r]));
              const bars = days.map((d) => {
                const v = Number(byDay.get(d)?.day_pnl ?? 0);
                return { value: v, itemStyle: { color: v < 0 ? t.red : t.green, opacity: 0.55 } };
              });
              const cumulative = days.map((d) => Number(byDay.get(d)?.cumulative ?? 0));
              const lines = showAccounts
                ? perAccount.map((id, i) => {
                    const color = id === focus ? t.text : colorOf(id);
                    const dim = focus !== null && id !== focus;
                    return {
                      name: name(id),
                      type: "line",
                      showSymbol: days.length < 40,
                      z: id === focus ? 5 : color ? 3 : 2,
                      emphasis: { focus: "series" },
                      lineStyle: { width: id === focus ? 2.5 : color ? 1.75 : 1, color: color ?? t.lineStrong, opacity: dim ? 0.25 : color ? 1 : 0.6 },
                      itemStyle: { color: color ?? t.lineStrong },
                      data: cumulativeFor(id).map((p) => p[1]),
                      ...(i === 0 ? { markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: t.lineStrong, type: "dashed" as const, width: 1 }, data: [{ yAxis: 0 }] } } : {}),
                    };
                  })
                : [
                    { name: "Day", type: "bar", data: bars, barMaxWidth: 28 },
                    {
                      name: "Cumulative",
                      type: "line",
                      showSymbol: days.length < 40,
                      lineStyle: { width: 2.5, color: t.text },
                      itemStyle: { color: t.text },
                      data: cumulative,
                      markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: t.lineStrong, type: "dashed" as const, width: 1 }, data: [{ yAxis: 0 }] },
                    },
                  ];
              return {
                animation: false,
                tooltip: {
                  trigger: "axis",
                  confine: true,
                  backgroundColor: t.raised,
                  borderColor: t.line,
                  textStyle: { color: t.text },
                  formatter: (params: { seriesName: string; value: number; color: string; axisValue: string }[]) => {
                    if (!params.length) return "";
                    const head = params[0].axisValue;
                    if (!showAccounts) {
                      const at = byDay.get(head);
                      return `${head}<br/>Day <b>${money(String(at?.day_pnl ?? 0))} ${currency}</b><br/>Since ${from} <b>${money(String(at?.cumulative ?? 0))}</b><br/><span style="opacity:.7">${at?.accounts ?? 0} accounts reported</span>`;
                    }
                    const rows = [...params].sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
                    const shown = rows.slice(0, 8).map((p) => `<span style="color:${p.color}">●</span> ${p.seriesName} <b>${money(String(p.value))}</b>`);
                    const more = rows.length > 8 ? [`<span style="opacity:.7">+${rows.length - 8} more</span>`] : [];
                    return [`${head} · cumulative`, ...shown, ...more].join("<br/>");
                  },
                },
                grid: { left: 8, right: 16, top: 16, bottom: 56, containLabel: true },
                dataZoom: [
                  { type: "inside", filterMode: "none", start: zoom.start, end: zoom.end },
                  { type: "slider", filterMode: "none", start: zoom.start, end: zoom.end, height: 18, bottom: 6, borderColor: t.line, fillerColor: "rgba(128,128,128,0.15)", textStyle: { color: t.muted }, showDataShadow: false },
                ],
                xAxis: {
                  type: "category",
                  data: days,
                  axisLine: { lineStyle: { color: t.line } },
                  axisTick: { show: false },
                  axisLabel: { color: t.muted, hideOverlap: true, formatter: (v: string) => v.slice(5) },
                  splitLine: { show: false },
                },
                yAxis: {
                  type: "value",
                  scale: true,
                  axisLine: { show: false },
                  axisTick: { show: false },
                  axisLabel: { color: t.muted, formatter: (v: number) => compact(v) },
                  splitLine: { lineStyle: { color: t.grid } },
                },
                series: lines,
              };
            }}
          />
          {desk && (
            <div className="day-pnl-standings" aria-label={`${periodLabel} P&L by account`}>
              <div className="day-pnl-standings-head">
                <span>{periodLabel} by account</span>
                {focus && (
                  <button type="button" onClick={() => setFocus(null)}>
                    Clear highlight
                  </button>
                )}
              </div>
              <ol>
                {standings
                  .filter((s) => s.value !== null)
                  .map((s) => {
                    const color = colorOf(s.id);
                    const width = `${(Math.abs(s.value!) / scale) * 100}%`;
                    return (
                      <li key={s.id}>
                        <button
                          type="button"
                          className={focus === s.id ? "on" : ""}
                          aria-pressed={focus === s.id}
                          title={s.stale && s.at ? `Last figure ${formatDateTime(s.at, zone)}` : undefined}
                          onClick={() => {
                            setFocus(focus === s.id ? null : s.id);
                            setMode("accounts");
                          }}
                        >
                          <i style={{ background: color ?? "transparent", borderColor: color ?? "var(--line-strong)" }} />
                          <span className="id" title={name(s.id)}>{name(s.id)}</span>
                          <span className={`bar ${s.value! < 0 ? "neg" : "pos"}`}>
                            <span style={{ width }} />
                          </span>
                          <span className={`amt ${s.value! < 0 ? "negative" : "positive"}`}>
                            {compact(s.value!)}
                            {s.stale && <small> stale</small>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
              </ol>
            </div>
          )}
        </div>
      ) : intraday.isPending ? (
        <ChartSkeleton label="Loading today's P&L" height={300} />
      ) : intraday.isError ? (
        <p role="alert" className="footnote">Day P&amp;L could not be loaded.</p>
      ) : assetFilter && stamps.length < 2 ? (
        <p className="footnote">
          Not enough points yet for {assetChoice.selected.join(", ")} today. Per-asset P&amp;L is
          sampled every few minutes, so the curve fills in as the session runs.
        </p>
      ) : stamps.length < 2 ? (
        <p className="footnote">
          Not enough points yet for today. The worker records one every few minutes, so the curve
          fills in as the session runs.
        </p>
      ) : (
        <div className={desk ? "day-pnl-body" : undefined}>
          <Chart
            height={320}
            ariaLabel={`Day profit and loss through ${date} in ${zoneLabel} for ${scope.join(", ")}`}
            unavailable="Chart unavailable."
            deps={[stamps.join(","), perAccount.join(","), combined.length, zone, mode, focus, desk, liveTotal, liveAt, scope.map((id) => liveById.get(id)?.day_pnl ?? "").join(",")]}
            option={(t, zoom) => {
              const zeroLine = {
                silent: true,
                symbol: "none",
                label: { show: false },
                lineStyle: { color: t.lineStrong, type: "dashed" as const, width: 1 },
                data: [{ yAxis: 0 }],
              };
              const signed = (data: [number, number][]) => {
                const ys = data.map((d) => d[1]);
                const hi = Math.max(0, ...ys), lo = Math.min(0, ...ys);
                const z = hi === lo ? (hi > 0 ? 1 : 0) : Math.min(1, Math.max(0, hi / (hi - lo)));
                const gradient = {
                  type: "linear" as const,
                  x: 0,
                  y: 0,
                  x2: 0,
                  y2: 1,
                  colorStops: [
                    { offset: 0, color: t.green },
                    { offset: z, color: t.green },
                    { offset: z, color: t.red },
                    { offset: 1, color: t.red },
                  ],
                };
                return { data, gradient };
              };
              const total = extendLive(
                combined.map((r) => [Date.parse(r.taken_at), Number(r.day_pnl)] as [number, number]),
                liveAt,
                liveTotal,
              );
              const single = !desk ? pointsFor(perAccount[0]) : [];
              const main = showCombined ? signed(total) : !desk ? signed(single) : null;

              const lines = showCombined || !desk
                ? [
                    {
                      name: showCombined ? "Combined" : name(perAccount[0]),
                      type: "line",
                      showSymbol: false,
                      lineStyle: { width: 2.5, color: main!.gradient },
                      itemStyle: { color: main!.gradient },
                      areaStyle: { origin: 0, opacity: 0.12, color: main!.gradient },
                      data: main!.data,
                      markLine: zeroLine,
                    },
                  ]
                : perAccount
                    .filter((id) => !unreported.has(id))
                    .map((id, i) => {
                      const color = id === focus ? t.text : colorOf(id);
                      const dim = focus !== null && id !== focus;
                      return {
                        name: name(id),
                        type: "line",
                        showSymbol: false,
                        z: id === focus ? 5 : color ? 3 : 2,
                        emphasis: { focus: "series" },
                        lineStyle: {
                          width: id === focus ? 2.5 : color ? 1.75 : 1,
                          color: color ?? t.lineStrong,
                          opacity: dim ? 0.25 : color ? 1 : 0.6,
                        },
                        itemStyle: { color: color ?? t.lineStrong },
                        data: pointsFor(id),
                        ...(i === 0 ? { markLine: zeroLine } : {}),
                      };
                    });

              return {
                animation: false,
                tooltip: {
                  trigger: "axis",
                  confine: true,
                  backgroundColor: t.raised,
                  borderColor: t.line,
                  textStyle: { color: t.text },
                  formatter: (params: { seriesName: string; value: [number, number]; color: string }[]) => {
                    if (!params.length) return "";
                    const head = formatDateTime(params[0].value[0], zone);
                    if (showCombined) {
                      const at = combined.find((r) => Date.parse(r.taken_at) === params[0].value[0]);
                      const note = at?.carried ? `<br/><span style="opacity:.7">${at.carried} account${at.carried > 1 ? "s" : ""} at last known figure</span>` : "";
                      return `${head}<br/>Combined <b>${money(String(params[0].value[1]))} ${currency}</b><br/><span style="opacity:.7">${at?.accounts ?? "—"} accounts</span>${note}`;
                    }
                    const rows = [...params].sort((a, b) => Math.abs(b.value[1]) - Math.abs(a.value[1]));
                    const shown = rows.slice(0, 8).map(
                      (p) => `<span style="color:${p.color}">●</span> ${p.seriesName} <b>${money(String(p.value[1]))}</b>`,
                    );
                    const more = rows.length > 8 ? [`<span style="opacity:.7">+${rows.length - 8} more</span>`] : [];
                    return [head, ...shown, ...more].join("<br/>");
                  },
                },
                grid: { left: 8, right: 16, top: 16, bottom: 56, containLabel: true },
                dataZoom: [
                  { type: "inside", filterMode: "none", start: zoom.start, end: zoom.end },
                  {
                    type: "slider",
                    filterMode: "none",
                    start: zoom.start,
                    end: zoom.end,
                    height: 18,
                    bottom: 6,
                    borderColor: t.line,
                    fillerColor: "rgba(128,128,128,0.15)",
                    textStyle: { color: t.muted },
                    showDataShadow: false,
                    labelFormatter: (v: number) => hhmm(v, zone),
                  },
                ],
                xAxis: {
                  type: "time",
                  axisLine: { lineStyle: { color: t.line } },
                  axisTick: { show: false },
                  axisLabel: { color: t.muted, hideOverlap: true, formatter: (v: number) => hhmm(v, zone) },
                  splitLine: { show: false },
                },
                yAxis: {
                  type: "value",
                  scale: true,
                  axisLine: { show: false },
                  axisTick: { show: false },
                  axisLabel: { color: t.muted, formatter: (v: number) => compact(v) },
                  splitLine: { lineStyle: { color: t.grid } },
                },
                series: lines,
              };
            }}
          />

          {desk && (
            <div className="day-pnl-standings" aria-label="Latest day P&L by account">
              <div className="day-pnl-standings-head">
                <span>Latest by account</span>
                {focus && (
                  <button type="button" onClick={() => setFocus(null)}>
                    Clear highlight
                  </button>
                )}
              </div>
              <ol>
                {standings
                  .filter((s) => s.value !== null)
                  .map((s) => {
                    const color = colorOf(s.id);
                    const width = `${(Math.abs(s.value!) / scale) * 100}%`;
                    return (
                      <li key={s.id}>
                        <button
                          type="button"
                          className={focus === s.id ? "on" : ""}
                          aria-pressed={focus === s.id}
                          title={s.stale && s.at ? `No new figure since ${formatDateTime(s.at, zone)}` : undefined}
                          onClick={() => {
                            setFocus(focus === s.id ? null : s.id);
                            setMode("accounts");
                          }}
                        >
                          <i style={{ background: color ?? "transparent", borderColor: color ?? "var(--line-strong)" }} />
                          <span className="id" title={name(s.id)}>{name(s.id)}</span>
                          <span className={`bar ${s.value! < 0 ? "neg" : "pos"}`}>
                            <span style={{ width }} />
                          </span>
                          <span className={`amt ${s.value! < 0 ? "negative" : "positive"}`}>
                            {compact(s.value!)}
                            {s.stale && <small> stale</small>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
              </ol>
              {(liveStandings ? standings.some((s) => s.value === null) : unreported.size > 0) && (
                <p className="day-pnl-missing">
                  No figure from the broker today: {(liveStandings
                    ? standings.filter((s) => s.value === null).map((s) => s.id)
                    : [...unreported]).map(name).join(", ")}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      {assetFilter && (
        <p className="footnote">
          Showing {assetChoice.selected.join(", ")} only: the sum of IBKR&apos;s day P&amp;L on each
          open leg of those assets, plus legs closed earlier in the day. With every asset ticked the
          chart uses the broker&apos;s account-level figure instead, which also includes cash, FX and
          fees, so the two can differ slightly.
        </p>
      )}
      {daily ? (
        <p className="footnote">
          Each bar is the broker&apos;s own day P&amp;L as it stood at that day&apos;s last sample,
          summed across the accounts in view; the line runs those days up from {from}. Records
          start on {HISTORY_START}, when the desk went live on this platform, so longer periods
          are capped there. Scroll or drag the chart to zoom.
        </p>
      ) : (
        <p className="footnote">
          The broker&apos;s own daily P&amp;L, sampled as the session runs — it resets at IBKR&apos;s
          session boundary, not at midnight in the timezone shown. The combined line adds every
          account that reports a figure; if one drops out mid-session its last known figure is carried
          forward{lastStamp ? `, last sample ${formatDateTime(lastStamp, zone)}` : ""}. Scroll or drag
          the chart to zoom.
        </p>
      )}
    </section>
  );
}
