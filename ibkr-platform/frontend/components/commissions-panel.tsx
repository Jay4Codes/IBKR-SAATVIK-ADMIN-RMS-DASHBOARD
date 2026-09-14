"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { CommissionSummary } from "@/lib/types";
import { money } from "./tables";

export function CommissionsPanel({ accountId }: { accountId?: string }) {
  const path = accountId ? `/accounts/${accountId}/commissions` : "/commissions";
  const commissions = useQuery({
    queryKey: ["commissions", accountId ?? "desk"],
    queryFn: () => api<CommissionSummary>(path),
  });
  const data = commissions.data;
  const recentDays = [...(data?.by_day ?? [])].reverse().slice(0, 10);

  return (
    <section className="panel">
      <h2>Commissions</h2>
      {commissions.isPending ? (
        <p role="status">Loading commission spend…</p>
      ) : commissions.isError ? (
        <p role="alert">Commission totals could not be loaded.</p>
      ) : (
        <>
          <div className="kpis">
            <div>
              <label>Total commissions spent</label>
              <strong>{money(data!.total)}</strong>
              <small>{data!.count} execution{data!.count === 1 ? "" : "s"} with a reported commission</small>
            </div>
            {!accountId &&
              data!.by_account.map((row) => (
                <div key={row.account_id}>
                  <label>{row.account_id}</label>
                  <strong>{money(row.commission)}</strong>
                  <small>Commission spend</small>
                </div>
              ))}
          </div>
          {recentDays.length > 0 && (
            <table>
              <caption>Commission spend by day, most recent first</caption>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Commission</th>
                </tr>
              </thead>
              <tbody>
                {recentDays.map((row) => (
                  <tr key={row.date}>
                    <th>{row.date}</th>
                    <td>{money(row.commission)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="footnote">
            Commission only appears once IBKR reports it against an execution; a fill without a
            commission report yet is not counted.
          </p>
        </>
      )}
    </section>
  );
}
