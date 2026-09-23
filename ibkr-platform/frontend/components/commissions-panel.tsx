"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { CommissionSummary } from "@/lib/types";
import { money } from "./tables";
import { TablePager, usePagedRows } from "./table-pager";
import { LinesSkeleton } from "./skeleton";

export function CommissionsPanel({ accountId }: { accountId?: string }) {
  const path = accountId ? `/accounts/${accountId}/commissions` : "/commissions";
  const commissions = useQuery({
    queryKey: ["commissions", accountId ?? "desk"],
    queryFn: () => api<CommissionSummary>(path),
  });
  const data = commissions.data;
  const recentDays = [...(data?.by_day ?? [])].reverse();
  const paged = usePagedRows(recentDays);

  return (
    <section className="panel">
      <h2>Commissions</h2>
      {commissions.isPending ? (
        <LinesSkeleton label="Loading commission spend" lines={3} />
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
                {paged.rows.map((row) => (
                  <tr key={row.date}>
                    <th>{row.date}</th>
                    <td>{money(row.commission)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <TablePager page={paged.page} pages={paged.pages} total={paged.total} onPage={paged.setPage} />
          <p className="footnote">
            Commission only appears once IBKR reports it against an execution; a fill without a
            commission report yet is not counted.
          </p>
        </>
      )}
    </section>
  );
}
