"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { CommissionSummary, RealizedSummary } from "@/lib/types";
import { Amount, money } from "./tables";

/** The headline figures, before any chart.
 *
 *  Booked P&L leads because it is the one the desk cannot see anywhere else:
 *  a closed leg leaves the position feed entirely, so a page built from open
 *  positions reports a book that has been adjusted as though it never was.
 */
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

  const booked = Number(realized.data?.total ?? 0);
  // Every commission the broker has reported, not only the cycle's: this card
  // is the lifetime cost, and the payoff panel is where a cycle is modelled.
  const spent = Number(commissions.data?.total ?? 0);
  const pending = realized.isPending || commissions.isPending;

  return (
    <section className="panel">
      <h2>P&amp;L<span>Booked, and what it cost</span></h2>
      {pending ? (
        <p role="status">Loading P&amp;L…</p>
      ) : (
        <>
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
              <strong>{realized.data?.count ?? 0}</strong>
            </div>
          </div>
          <p className="footnote">
            Booked P&amp;L covers every cycle the broker has reported, including ones that have
            expired — unlike the payoff panel, which models the live cycle only. Commissions
            total {money(String(spent))} across {commissions.data?.count ?? 0} fills.
          </p>
        </>
      )}
    </section>
  );
}
