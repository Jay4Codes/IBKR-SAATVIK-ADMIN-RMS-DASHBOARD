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
  const byAccount = [...(data?.by_account ?? [])].sort((a, b) => Number(b.commission) - Number(a.commission));
  const accountPage = usePagedRows(byAccount, byAccount.map((r) => r.account_id).join("\0"));
  const total = Number(data?.total ?? 0);

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
            {!accountId && byAccount.length > 0 && (
              <div>
                <label>Accounts charged</label>
                <strong>{byAccount.length}</strong>
                <small>Largest: {byAccount[0].account_id} at {money(byAccount[0].commission)}</small>
              </div>
            )}
            {recentDays.length > 0 && (
              <div>
                <label>Latest day</label>
                <strong>{money(recentDays[0].commission)}</strong>
                <small>{recentDays[0].date}</small>
              </div>
            )}
          </div>
          {!accountId && byAccount.length > 0 && (
            <div className="pnl-breakdown">
              <table>
                <caption>Commission spend by account, largest first</caption>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Commission</th>
                    <th>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {accountPage.rows.map((row) => (
                    <tr key={row.account_id}>
                      <th>{row.account_id}</th>
                      <td>{money(row.commission)}</td>
                      <td>{total ? `${((Number(row.commission) / total) * 100).toFixed(1)}%` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <TablePager page={accountPage.page} pages={accountPage.pages} total={accountPage.total} onPage={accountPage.setPage} />
            </div>
          )}
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
