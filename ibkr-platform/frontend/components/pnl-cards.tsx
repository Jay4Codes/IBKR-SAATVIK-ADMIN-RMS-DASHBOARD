"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { CommissionSummary, RealizedSummary } from "@/lib/types";
import { Amount, money } from "./tables";
import { TablePager, usePagedRows } from "./table-pager";
import { expiryLabel, NO_EXPIRY } from "@/lib/risk-lenses";
import { SearchableMultiSelect } from "./searchable-multi-select";
import { Selection, useCrossSelection } from "./selection";
import { LinesSkeleton } from "./skeleton";
import { useAccountNames } from "./account-names";

const expiryKey = (expiry: string | null | undefined) => expiry || NO_EXPIRY;

export function chosen(choice: Selection, fallback: string): boolean {
  if (choice.isAll) return true;
  if (!fallback) return false;
  return choice.has(fallback);
}

export function PnlCards({ accountId }: { accountId?: string }) {
  const { name } = useAccountNames();
  const scope = accountId ? `&accounts=${encodeURIComponent(accountId)}` : "";
  const realized = useQuery({
    queryKey: ["realized", "cards", accountId ?? "desk"],
    queryFn: () => api<RealizedSummary>(`/realized?limit=500${scope}`),
  });
  const commissions = useQuery({
    queryKey: ["commissions", accountId ?? "desk"],
    queryFn: () => api<CommissionSummary>(accountId ? `/accounts/${accountId}/commissions` : "/commissions"),
  });

  const legs = (realized.data?.legs ?? []).filter(leg => !accountId || leg.account_id === accountId);
  const fills = (commissions.data?.fills ?? []).filter(fill => !accountId || fill.account_id === accountId);
  const rows = [
    ...legs.map(leg => ({ account: leg.account_id, expiry: expiryKey(leg.expiry) })),
    ...fills.map(fill => ({ account: fill.account_id, expiry: expiryKey(fill.expiry) })),
  ].filter(row => row.account || row.expiry);
  const linked = useCrossSelection(rows, {
    account: row => row.account,
    expiry: row => row.expiry,
  }, {
    expiry: (a, b) => (a === NO_EXPIRY ? 1 : b === NO_EXPIRY ? -1 : a.localeCompare(b)),
  });
  const accountChoice = linked.account;
  const expiryChoice = linked.expiry;
  const shownLegs = legs.filter(leg => chosen(accountChoice, leg.account_id) && chosen(expiryChoice, expiryKey(leg.expiry)));
  const shownFills = fills.filter(fill => chosen(accountChoice, fill.account_id) && chosen(expiryChoice, expiryKey(fill.expiry)));

  const booked = shownLegs.reduce((sum, leg) => sum + Number(leg.realized_pnl || 0), 0);
  const spent = fills.length
    ? shownFills.reduce((sum, fill) => sum + Number(fill.commission || 0), 0)
    : Number(commissions.data?.total ?? 0);
  const closings = shownLegs.filter(leg => Number(leg.realized_pnl || 0) !== 0).length;
  const fillCount = fills.length ? shownFills.length : (commissions.data?.count ?? 0);
  const pending = realized.isPending || commissions.isPending;

  const accountsInView = [...new Set([
    ...shownLegs.map(leg => leg.account_id),
    ...shownFills.map(fill => fill.account_id),
  ].filter(Boolean))].sort();
  const accountPage = usePagedRows(accountsInView, accountsInView.join("\0"));
  const expiryHint = (expiry: string) => {
    const closings = legs.filter(leg =>
      expiryKey(leg.expiry) === expiry && chosen(accountChoice, leg.account_id) && Number(leg.realized_pnl || 0) !== 0,
    ).length;
    return `${closings} closing ${closings === 1 ? "fill" : "fills"}`;
  };
  const bookedFor = (account: string) =>
    shownLegs.filter(leg => leg.account_id === account).reduce((sum, leg) => sum + Number(leg.realized_pnl || 0), 0);
  const spentFor = (account: string) =>
    shownFills.filter(fill => fill.account_id === account).reduce((sum, fill) => sum + Number(fill.commission || 0), 0);
  const closingsFor = (account: string) =>
    shownLegs.filter(leg => leg.account_id === account && Number(leg.realized_pnl || 0) !== 0).length;

  return (
    <section className="panel">
      <h2>P&amp;L<span>Booked, and what it cost</span></h2>
      {pending ? (
        <LinesSkeleton label="Loading P&L" lines={4} />
      ) : (
        <>
          {(accountChoice.options.length > 1 || expiryChoice.options.length > 1) && (
            <div className="pnl-filters">
              {!accountId && accountChoice.options.length > 1 && (
                <SearchableMultiSelect label="Accounts" noun="accounts" selection={accountChoice} searchFrom={2} format={name} describe={name} />
              )}
              {expiryChoice.options.length > 1 && (
                <SearchableMultiSelect
                  label="Expiry"
                  noun="expiries"
                  selection={expiryChoice}
                  searchFrom={2}
                  format={expiryLabel}
                  describe={expiryHint}
                />
              )}
            </div>
          )}
          <div className="balance-grid">
            <div>
              <label>Booked P&amp;L</label>
              <small>Realised on legs that have been closed, gross of commission.</small>
              <strong><Amount value={String(booked)} /></strong>
            </div>
            <div>
              <label>Commissions</label>
              <small>Every fill the broker has reported a commission for.</small>
              <strong><Amount value={String(-spent)} /></strong>
            </div>
            <div>
              <label>Net of commission</label>
              <small>Booked P&amp;L less what was paid to book it.</small>
              <strong><Amount value={String(booked - spent)} /></strong>
            </div>
            <div>
              <label>Closing fills</label>
              <small>Fills that booked something. Opening fills realise nothing.</small>
              <strong>{closings}</strong>
            </div>
          </div>
          {!accountId && accountsInView.length > 1 && (
            <div className="pnl-breakdown">
              <table>
                <caption>By account</caption>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Booked P&amp;L</th>
                    <th>Commissions</th>
                    <th>Net of commission</th>
                    <th>Closing fills</th>
                  </tr>
                </thead>
                <tbody>
                  {accountPage.rows.map(account => {
                    const bookedAccount = bookedFor(account);
                    const spentAccount = spentFor(account);
                    return (
                      <tr key={account}>
                        <th>{name(account)}</th>
                        <td><Amount value={String(bookedAccount)} /></td>
                        <td><Amount value={String(-spentAccount)} /></td>
                        <td><Amount value={String(bookedAccount - spentAccount)} /></td>
                        <td>{closingsFor(account)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <TablePager page={accountPage.page} pages={accountPage.pages} total={accountPage.total} onPage={accountPage.setPage} />
            </div>
          )}
          <p className="footnote">
            Booked P&amp;L covers {expiryChoice.isAll ? "every cycle the broker has reported, including ones that have expired" : expiryChoice.selected.map(expiryLabel).join(", ")} — unlike the payoff panel, which models the live cycle only. Commissions
            total {money(String(spent))} across {fillCount} fills.
          </p>
        </>
      )}
    </section>
  );
}
