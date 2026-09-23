"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Decimal from "decimal.js";
import { api } from "@/lib/api";
import { IntradayResponse } from "@/lib/types";
import { formatDateTime, todayIn, ZONES, ZoneId, zoneOf } from "@/lib/timezone";
import { Chart } from "./chart";
import { SelectionActions, useSelection } from "./selection";
import { money } from "./tables";
import { useZone } from "./timezone";
import { ChartSkeleton } from "./skeleton";

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
  const choice = useSelection(accounts);
  const scope = accountId ? [accountId] : choice.selected;
  const date = todayIn(zone);
  const desk = !accountId && accounts.length > 1;
  const [mode, setMode] = useState<Mode>("combined");
  const [focus, setFocus] = useState<string | null>(null);

  const intraday = useQuery({
    queryKey: ["intraday", scope.join(","), date],
    queryFn: () =>
      api<IntradayResponse>(
        `/history/intraday?accounts=${encodeURIComponent(scope.join(","))}&date=${date}`,
      ),
    enabled: scope.length > 0,
  });

  const series = intraday.data?.series ?? [];
  const combined = intraday.data?.combined ?? [];
  const unreported = new Set(intraday.data?.unreported ?? []);
  const perAccount = [...new Set(series.map((r) => r.account_id))].sort();
  const stamps = [...new Set(series.map((r) => r.taken_at))].sort();
  const zoneLabel = ZONES.find((z) => z.id === zone)?.id ?? zone;
  const currency = series[0]?.currency || "";
  const lastStamp = stamps[stamps.length - 1] ?? null;

  const pointsFor = (id: string) =>
    series
      .filter((r) => r.account_id === id && r.day_pnl != null)
      .map((r) => [Date.parse(r.taken_at), Number(r.day_pnl)] as [number, number]);

  const standings: Standing[] = perAccount
    .map((id) => {
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
  const latest = (() => {
    if (desk || (!accountId && combined.length)) return latestCombined ? new Decimal(latestCombined.day_pnl) : null;
    const v = valued[0]?.value;
    return v == null ? null : new Decimal(v);
  })();
  const showCombined = desk ? mode === "combined" : false;
  const scale = Math.max(1, ...valued.map((s) => Math.abs(s.value!)));

  return (
    <section className="panel day-pnl">
      <h2>
        Day P&amp;L
        <span>
          {date} · {zoneLabel}
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

      {!accountId && accounts.length > 1 && (
        <div className="day-pnl-toolbar">
          <div className="segmented sm" role="group" aria-label="Chart view">
            <button type="button" className={mode === "combined" ? "on" : ""} aria-pressed={mode === "combined"} onClick={() => setMode("combined")}>
              Combined
            </button>
            <button type="button" className={mode === "accounts" ? "on" : ""} aria-pressed={mode === "accounts"} onClick={() => setMode("accounts")}>
              By account <small>{perAccount.length}</small>
            </button>
          </div>
          <details className="day-pnl-accounts">
            <summary>Accounts · {choice.summary}</summary>
            <fieldset className="account-picker">
              <legend>Accounts in this view</legend>
              <SelectionActions selection={choice} noun="accounts" />
              {accounts.map((id) => (
                <label key={id}>
                  <input type="checkbox" checked={choice.has(id)} onChange={() => choice.toggle(id)} />
                  {id}
                </label>
              ))}
            </fieldset>
          </details>
        </div>
      )}

      {!scope.length ? (
        <p role="status" className="footnote">No accounts selected. Open Accounts above and tick one to draw its day P&amp;L.</p>
      ) : intraday.isPending ? (
        <ChartSkeleton label="Loading today's P&L" height={300} />
      ) : intraday.isError ? (
        <p role="alert" className="footnote">Day P&amp;L could not be loaded.</p>
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
            deps={[stamps.join(","), perAccount.join(","), combined.length, zone, mode, focus, desk]}
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
              const total: [number, number][] = combined.map((r) => [Date.parse(r.taken_at), Number(r.day_pnl)]);
              const single = !desk ? pointsFor(perAccount[0]) : [];
              const main = showCombined ? signed(total) : !desk ? signed(single) : null;

              const lines = showCombined || !desk
                ? [
                    {
                      name: showCombined ? "Combined" : perAccount[0],
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
                        name: id,
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
                          <span className="id">{s.id}</span>
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
              {unreported.size > 0 && (
                <p className="day-pnl-missing">
                  No figure from the broker today: {[...unreported].join(", ")}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      <p className="footnote">
        The broker&apos;s own daily P&amp;L, sampled as the session runs — it resets at IBKR&apos;s
        session boundary, not at midnight in the timezone shown. The combined line adds every
        account that reports a figure; if one drops out mid-session its last known figure is carried
        forward{lastStamp ? `, last sample ${formatDateTime(lastStamp, zone)}` : ""}. Scroll or drag
        the chart to zoom.
      </p>
    </section>
  );
}
