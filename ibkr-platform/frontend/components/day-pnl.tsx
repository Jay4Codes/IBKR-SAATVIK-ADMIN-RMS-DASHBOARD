"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Decimal from "decimal.js";
import { api } from "@/lib/api";
import { IntradayResponse } from "@/lib/types";
import { formatDateTime, formatTime, todayIn, ZONES } from "@/lib/timezone";
import { Chart } from "./chart";
import { money } from "./tables";
import { useZone } from "./timezone";

/** Day P&L through the session, per account and combined.
 *
 *  Drawn from the worker's snapshots, so the curve begins where recording began
 *  and gains a point every `SNAPSHOT_SECONDS`. The x axis is labelled in
 *  whichever timezone the header is set to, and the day it asks for is that
 *  zone's today — a reader in IST looking at "today" means their today.
 */
export function DayPnlPanel({ accountId, accounts }: { accountId?: string; accounts: string[] }) {
  const zone = useZone();
  const [chosen, setChosen] = useState<string[]>([]);
  const scope = accountId ? [accountId] : chosen.length ? chosen : accounts;
  const date = todayIn(zone);

  const intraday = useQuery({
    queryKey: ["intraday", scope.join(","), date],
    queryFn: () =>
      api<IntradayResponse>(
        `/history/intraday?accounts=${encodeURIComponent(scope.join(","))}&date=${date}`,
      ),
    enabled: scope.length > 0,
    refetchInterval: 60000,
  });

  const series = intraday.data?.series ?? [];
  const combined = intraday.data?.combined ?? [];
  const perAccount = [...new Set(series.map((r) => r.account_id))].sort();
  const stamps = [...new Set(series.map((r) => r.taken_at))].sort();
  const labels = stamps.map((stamp) => formatTime(stamp, zone));
  const zoneLabel = ZONES.find((z) => z.id === zone)?.id ?? zone;
  const currency = series[0]?.currency || "";

  const lineFor = (id: string) => {
    const byStamp = new Map(
      series.filter((r) => r.account_id === id).map((r) => [r.taken_at, r.day_pnl]),
    );
    return stamps.map((stamp) => {
      const value = byStamp.get(stamp);
      return value === undefined || value === null ? null : Number(value);
    });
  };
  const totalByStamp = new Map(combined.map((r) => [r.taken_at, r.day_pnl]));

  const latest = (() => {
    const source = !accountId && combined.length ? combined : series.filter((r) => r.account_id === perAccount[0]);
    const last = source[source.length - 1];
    return last?.day_pnl == null ? null : new Decimal(last.day_pnl);
  })();

  return (
    <section className="panel">
      <h2>
        Day P&amp;L
        <span>
          {date} · {zoneLabel}
          {latest ? " · " : ""}
          {latest && (
            <b className={latest.isNegative() ? "negative" : "positive"}>
              {money(latest.toString())} {currency}
            </b>
          )}
        </span>
      </h2>
      {!accountId && accounts.length > 1 && (
        <fieldset className="account-picker">
          <legend>Accounts in this view</legend>
          {accounts.map((id) => (
            <label key={id}>
              <input
                type="checkbox"
                checked={scope.includes(id)}
                onChange={(event) =>
                  setChosen((current) => {
                    const base = current.length ? current : accounts;
                    const next = event.target.checked ? [...base, id] : base.filter((a) => a !== id);
                    return next.length ? [...new Set(next)] : accounts;
                  })
                }
              />
              {id}
            </label>
          ))}
        </fieldset>
      )}
      {intraday.isPending ? (
        <p role="status">Loading today&apos;s P&amp;L…</p>
      ) : intraday.isError ? (
        <p role="alert">Day P&amp;L could not be loaded.</p>
      ) : stamps.length < 2 ? (
        <p className="footnote">
          Not enough points yet for today. The worker records one every few minutes, so the curve
          fills in as the session runs.
        </p>
      ) : (
        <Chart
          height={300}
          ariaLabel={`Day profit and loss through ${date} in ${zoneLabel} for ${scope.join(", ")}`}
          unavailable="Chart unavailable."
          deps={[labels.join(","), perAccount.join(","), combined.length, zone]}
          option={(t) => ({
            animation: false,
            legend: { type: "scroll", top: 4, left: "center", textStyle: { color: t.muted } },
            tooltip: {
              trigger: "axis",
              confine: true,
              renderMode: "richText",
              // The heading carries the full stamp; the axis only has room for a time.
              formatter: (params: { dataIndex: number; seriesName: string; value: number }[]) => {
                const index = params[0]?.dataIndex ?? 0;
                const head = formatDateTime(stamps[index], zone);
                const lines = params
                  .filter((p) => p.value !== null && p.value !== undefined)
                  .map((p) => `${p.seriesName}  ${money(String(p.value))} ${currency}`);
                return [head, ...lines].join("\n");
              },
            },
            grid: { left: 12, right: 20, top: 40, bottom: 52, containLabel: true },
            xAxis: {
              type: "category",
              data: labels,
              name: `Time (${zoneLabel})`,
              nameLocation: "middle",
              nameGap: 30,
              nameTextStyle: { color: t.muted },
              axisLine: { lineStyle: { color: t.line } },
              axisTick: { show: false },
              axisLabel: { color: t.muted, hideOverlap: true },
              splitLine: { show: false },
            },
            yAxis: {
              type: "value",
              scale: true,
              name: currency ? `Day P&L (${currency})` : "Day P&L",
              nameLocation: "middle",
              nameRotate: 90,
              nameGap: 62,
              nameTextStyle: { color: t.muted },
              axisLine: { show: false },
              axisTick: { show: false },
              axisLabel: { color: t.muted },
              splitLine: { lineStyle: { color: t.grid } },
            },
            series: [
              ...(!accountId && combined.length
                ? [
                    {
                      name: "Combined",
                      type: "line",
                      showSymbol: false,
                      connectNulls: true,
                      lineStyle: { width: 3 },
                      data: stamps.map((s) => {
                        const v = totalByStamp.get(s);
                        return v === undefined ? null : Number(v);
                      }),
                      // Zero is the reference a day's P&L is read against.
                      markLine: {
                        silent: true,
                        symbol: "none",
                        label: { show: false },
                        lineStyle: { color: t.lineStrong },
                        data: [{ yAxis: 0 }],
                      },
                    },
                  ]
                : []),
              ...perAccount.map((id) => ({
                name: id,
                type: "line",
                showSymbol: false,
                connectNulls: true,
                lineStyle: { width: perAccount.length === 1 ? 3 : 1.5 },
                data: lineFor(id),
                ...(accountId || !combined.length
                  ? {
                      markLine: {
                        silent: true,
                        symbol: "none",
                        label: { show: false },
                        lineStyle: { color: t.lineStrong },
                        data: [{ yAxis: 0 }],
                      },
                    }
                  : {}),
              })),
            ],
          })}
        />
      )}
      <p className="footnote">
        The broker&apos;s own daily P&amp;L, sampled as the session runs — it resets at IBKR&apos;s
        session boundary, not at midnight in the timezone shown. A point is only added to the
        combined line once every selected account has a figure for it.
      </p>
    </section>
  );
}
