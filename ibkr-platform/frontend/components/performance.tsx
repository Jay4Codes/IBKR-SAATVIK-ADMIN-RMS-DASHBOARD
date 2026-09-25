"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Decimal from "decimal.js";
import { api } from "@/lib/api";
import { HistoryResponse } from "@/lib/types";
import { HISTORY_START, sinceDays } from "@/lib/history";
import { DownloadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chart } from "./chart";
import { SelectionActions, useSelection } from "./selection";
import { money } from "./tables";
import { ChartSkeleton } from "./skeleton";
import { useAccountNames } from "./account-names";

const RANGES = [
  { label: "1W", days: 7 },
  { label: "1M", days: 30 },
  { label: "3M", days: 91 },
  { label: "1Y", days: 365 },
  { label: "All", days: 0 },
] as const;

function since(days: number): string {
  return sinceDays(days);
}

export function PerformancePanel({
  accountId,
  accounts,
  isAdmin = false,
}: {
  accountId?: string;
  accounts: string[];
  isAdmin?: boolean;
}) {
  const client = useQueryClient();
  const { name } = useAccountNames();
  const [days, setDays] = useState<number>(91);
  const choice = useSelection(accounts);
  const [combined, setCombined] = useState(true);

  const scope = accountId ? [accountId] : choice.selected;
  const key = ["history", scope.join(","), days];
  const history = useQuery({
    queryKey: key,
    queryFn: () => {
      const params = new URLSearchParams();
      if (!accountId) params.set("accounts", scope.join(","));
      params.set("since", since(days));
      const query = params.toString();
      return accountId
        ? api<HistoryResponse["series"]>(`/accounts/${accountId}/history${query ? `?${query}` : ""}`).then(
            (series) => ({ accounts: [accountId], series, combined: [] }) as HistoryResponse,
          )
        : api<HistoryResponse>(`/history${query ? `?${query}` : ""}`);
    },
    enabled: scope.length > 0,
  });

  const series = history.data?.series ?? [];
  const total = history.data?.combined ?? [];
  const perAccount = [...new Set(series.map((row) => row.account_id))].sort();
  const dates = [...new Set([...series.map((r) => r.report_date), ...total.map((r) => r.report_date)])].sort();
  const currencies = [...new Set(series.map((row) => row.currency || "BASE"))];
  const mixed = currencies.length > 1;

  const line = (id: string) => {
    const byDate = new Map(series.filter((r) => r.account_id === id).map((r) => [r.report_date, r.net_liquidation]));
    return dates.map((date) => [date, byDate.has(date) ? Number(byDate.get(date)) : null]);
  };
  const totalByDate = new Map(total.map((r) => [r.report_date, r.net_liquidation]));

  const change = (() => {
    const source = !accountId && combined && total.length ? total : series.filter((r) => r.account_id === perAccount[0]);
    if (source.length < 2) return null;
    const first = new Decimal(source[0].net_liquidation);
    const last = new Decimal(source[source.length - 1].net_liquidation);
    if (first.isZero()) return null;
    return { absolute: last.minus(first), percent: last.minus(first).div(first).mul(100) };
  })();

  const backfill = useMutation({
    mutationFn: () => api<{ written: number; points: number }>("/admin/history/backfill", {}),
    onSuccess: () => client.invalidateQueries({ queryKey: ["history"] }),
  });

  return (
    <section className="panel">
      <h2>
        {accountId ? "Account performance" : "Portfolio performance"}
        <span>{accountId ? name(accountId) : `${scope.length} of ${accounts.length} accounts`}</span>
        {isAdmin && !accountId && (
          <span className="panel-actions">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={backfill.isPending}
              title="Pull the broker's own daily net liquidation from IBKR Flex"
              onClick={() => backfill.mutate()}
            >
              <DownloadCloud size={14} aria-hidden="true" />
              {backfill.isPending ? "Backfilling…" : "Backfill from Flex"}
            </Button>
          </span>
        )}
      </h2>
      {backfill.isSuccess && (
        <p role="status" className="footnote">
          Flex backfill wrote {backfill.data.written} of {backfill.data.points} points.
        </p>
      )}
      {backfill.isError && (
        <p role="alert" className="risk-warning">
          {backfill.error instanceof Error ? backfill.error.message : "Flex backfill failed."}
        </p>
      )}
      <div className="risk-controls">
        <div className="control-group">
          <span className="control-caption">Range</span>
          <span className="tabs range-tabs" role="tablist" aria-label="History range">
            {RANGES.map((range) => (
              <button
                key={range.label}
                type="button"
                role="tab"
                aria-selected={days === range.days}
                className={days === range.days ? "active" : ""}
                onClick={() => setDays(range.days)}
              >
                {range.label}
              </button>
            ))}
          </span>
        </div>
        {!accountId && (
          <label>
            Combined line
            <input
              type="checkbox"
              checked={combined}
              onChange={(event) => setCombined(event.target.checked)}
            />
          </label>
        )}
      </div>
      {!accountId && accounts.length > 1 && (
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
      )}
      {!scope.length ? (
        <p role="status" className="footnote">No accounts selected. Tick an account above to draw its history.</p>
      ) : history.isPending ? (
        <ChartSkeleton label="Loading history" height={260} />
      ) : history.isError ? (
        <p role="alert">History could not be loaded.</p>
      ) : !dates.length ? (
        <p>
          No history recorded yet. Snapshots begin accumulating as soon as the worker runs; an
          administrator can pull the broker&apos;s own earlier figures in with a Flex backfill.
        </p>
      ) : (
        <>
          {mixed && (
            <p role="note" className="risk-warning">
              These accounts report in {currencies.join(", ")} and nothing here converts FX — the
              combined line adds different currencies together.
            </p>
          )}
          <Chart
            height={380}
            ariaLabel={`Net liquidation over time for ${scope.join(", ")}`}
            unavailable="Chart unavailable. The figures are listed below."
            deps={[dates.join(","), perAccount.join(","), combined, series.length, total.length]}
            option={(t, zoom) => ({
              animation: false,
              legend: { type: "scroll", top: 6, left: "center", textStyle: { color: t.muted } },
              tooltip: {
                trigger: "axis",
                confine: true,
                renderMode: "richText",
                valueFormatter: (v: number) => (v == null ? "—" : money(String(v))),
              },
              grid: { left: 16, right: 24, top: 46, bottom: 96, containLabel: true },
              dataZoom: [
                { type: "inside", xAxisIndex: 0, filterMode: "none", ...zoom },
                {
                  type: "slider",
                  xAxisIndex: 0,
                  filterMode: "none",
                  ...zoom,
                  bottom: 14,
                  height: 30,
                  brushSelect: false,
                  backgroundColor: "transparent",
                  borderColor: t.line,
                  fillerColor: `${t.accent}26`,
                  dataBackground: {
                    lineStyle: { color: t.muted, opacity: 0.7 },
                    areaStyle: { color: t.muted, opacity: 0.18 },
                  },
                  selectedDataBackground: {
                    lineStyle: { color: t.accent },
                    areaStyle: { color: t.accent, opacity: 0.28 },
                  },
                  handleSize: "110%",
                  handleStyle: { color: t.raised, borderColor: t.lineStrong },
                  moveHandleSize: 6,
                  moveHandleStyle: { color: t.lineStrong },
                  textStyle: { color: t.muted },
                },
              ],
              xAxis: {
                type: "category",
                data: dates,
                axisLine: { lineStyle: { color: t.line } },
                axisTick: { show: false },
                axisLabel: { color: t.muted },
                splitLine: { show: false },
              },
              yAxis: {
                type: "value",
                scale: true,
                name: "Net liquidation",
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
                ...(!accountId && combined && total.length
                  ? [
                      {
                        name: "Combined",
                        type: "line",
                        showSymbol: false,
                        connectNulls: true,
                        lineStyle: { width: 3 },
                        data: dates.map((d) => [d, totalByDate.has(d) ? Number(totalByDate.get(d)) : null]),
                      },
                    ]
                  : []),
                ...perAccount.map((id) => ({
                  name: name(id),
                  type: "line",
                  showSymbol: false,
                  connectNulls: true,
                  lineStyle: { width: perAccount.length === 1 ? 3 : 1.5 },
                  data: line(id),
                })),
              ],
            })}
          />
          <div className="risk-metrics">
            <span>
              Points <b>{dates.length}</b>
            </span>
            {change && (
              <>
                <span>
                  Change over range{" "}
                  <b className={change.absolute.isNegative() ? "negative" : "positive"}>
                    {money(change.absolute.toString())}
                  </b>
                </span>
                <span>
                  Return{" "}
                  <b className={change.percent.isNegative() ? "negative" : "positive"}>
                    {change.percent.toFixed(2)}%
                  </b>
                </span>
              </>
            )}
          </div>
          <p className="footnote">
            Net liquidation as the broker reported it, one point per trading day, starting from{" "}
            {HISTORY_START} when the desk went live on this platform. A day is only included in the
            combined line once every selected account has a figure for it, so a missing account
            cannot read as a drawdown.
          </p>
        </>
      )}
    </section>
  );
}
