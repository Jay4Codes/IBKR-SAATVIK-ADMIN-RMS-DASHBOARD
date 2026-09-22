"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { CommissionSummary, RealizedSummary } from "@/lib/types";
import { Amount, money } from "./tables";
import { SearchableMultiSelect } from "./searchable-multi-select";
import { Selection, useSelection } from "./selection";

export function chosen(choice: Selection, fallback: string): boolean {
  if (choice.isAll) return true;
  if (!fallback) return false;
  return choice.has(fallback);
}

export function PnlCards({ accountId }: { accountId?: string }) {
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
  const accountOptions = [...new Set([
    ...legs.map(leg => leg.account_id),
    ...fills.map(fill => fill.account_id),
  ].filter(Boolean))].sort();
  const idOptions = [...new Set([
    ...legs.map(leg => leg.execution_id),
    ...fills.map(fill => fill.execution_id),
  ].filter(Boolean))].sort();
  const accountChoice = useSelection(accountOptions);
  const idChoice = useSelection(idOptions);
  const shownLegs = legs.filter(leg => chosen(accountChoice, leg.account_id) && chosen(idChoice, leg.execution_id));
  const shownFills = fills.filter(fill => chosen(accountChoice, fill.account_id) && chosen(idChoice, fill.execution_id));

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
  const idsInView = [...new Set([
    ...shownLegs.map(leg => leg.execution_id),
    ...shownFills.map(fill => fill.execution_id),
  ].filter(Boolean))].sort();
  const idHint = (id: string) => {
    const leg = legs.find(row => row.execution_id === id);
    const fill = fills.find(row => row.execution_id === id);
    const account = leg?.account_id || fill?.account_id;
    const symbol = leg?.symbol;
    return [account, symbol].filter(Boolean).join(" · ");
  };
  const bookedFor = (account: string) =>
    shownLegs.filter(leg => leg.account_id === account).reduce((sum, leg) => sum + Number(leg.realized_pnl || 0), 0);
  const spentFor = (account: string) =>
    shownFills.filter(fill => fill.account_id === account).reduce((sum, fill) => sum + Number(fill.commission || 0), 0);
  const closingsFor = (account: string) =>
    shownLegs.filter(leg => leg.account_id === account && Number(leg.realized_pnl || 0) !== 0).length;
  const bookedId = (id: string) =>
    shownLegs.filter(leg => leg.execution_id === id).reduce((sum, leg) => sum + Number(leg.realized_pnl || 0), 0);
  const spentId = (id: string) =>
    shownFills.filter(fill => fill.execution_id === id).reduce((sum, fill) => sum + Number(fill.commission || 0), 0);

  return (
    <section className="panel">
      <h2>P&amp;L<span>Booked, and what it cost</span></h2>
      {pending ? (
        <p role="status">Loading P&amp;L…</p>
      ) : (
        <>
          {(accountOptions.length > 1 || idOptions.length > 1) && (
            <div className="pnl-filters">
              {!accountId && accountOptions.length > 1 && (
                <SearchableMultiSelect label="Accounts" noun="accounts" selection={accountChoice} searchFrom={2} />
              )}
              {idOptions.length > 1 && (
                <SearchableMultiSelect
                  label="IDs"
                  noun="execution IDs"
                  selection={idChoice}
                  searchFrom={2}
                  describe={idHint}
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
                  {accountsInView.map(account => {
                    const bookedAccount = bookedFor(account);
                    const spentAccount = spentFor(account);
                    return (
                      <tr key={account}>
                        <th>{account}</th>
                        <td><Amount value={String(bookedAccount)} /></td>
                        <td><Amount value={String(-spentAccount)} /></td>
                        <td><Amount value={String(bookedAccount - spentAccount)} /></td>
                        <td>{closingsFor(account)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {idsInView.length > 0 && (
            <div className="pnl-breakdown">
              <table>
                <caption>By execution ID</caption>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Account</th>
                    <th>Booked P&amp;L</th>
                    <th>Commissions</th>
                    <th>Net of commission</th>
                  </tr>
                </thead>
                <tbody>
                  {idsInView.map(id => {
                    const bookedFill = bookedId(id);
                    const spentFill = spentId(id);
                    const account = shownLegs.find(leg => leg.execution_id === id)?.account_id
                      ?? shownFills.find(fill => fill.execution_id === id)?.account_id
                      ?? "";
                    return (
                      <tr key={id}>
                        <th>{id}</th>
                        <td>{account}</td>
                        <td><Amount value={String(bookedFill)} /></td>
                        <td><Amount value={String(-spentFill)} /></td>
                        <td><Amount value={String(bookedFill - spentFill)} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="footnote">
            Booked P&amp;L covers every cycle the broker has reported, including ones that have
            expired — unlike the payoff panel, which models the live cycle only. Commissions
            total {money(String(spent))} across {fillCount} fills.
          </p>
        </>
      )}
    </section>
  );
}
