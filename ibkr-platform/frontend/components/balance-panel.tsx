"use client";

import { Account } from "@/lib/types";
import { money } from "./tables";

/** Every figure the desk is judged on by its broker, with what each one means.
 *
 *  The descriptions are not decoration: "available funds" and "excess
 *  liquidity" are different numbers measured against different requirements,
 *  and a row of bare labels invites reading one as the other.
 */
const FIELDS: { key: keyof Account; title: string; detail: string }[] = [
  { key: "net_liquidation", title: "Net liq", detail: "Net liquidation value (account equity)." },
  { key: "cash", title: "Cash", detail: "Total cash value." },
  { key: "buying_power", title: "Buying power", detail: "Available buying power." },
  { key: "gross_position_value", title: "Position value", detail: "Gross market value of positions." },
  { key: "initial_margin", title: "Init margin", detail: "Full initial margin requirement." },
  { key: "maintenance_margin", title: "Maint margin", detail: "Full maintenance margin requirement." },
  { key: "available_funds", title: "Avail funds", detail: "Funds available for trading." },
  { key: "excess_liquidity", title: "Excess liq", detail: "Excess liquidity buffer above maintenance margin." },
];

/** IBKR reports the cushion as a fraction; a percentage is how it is read. */
function cushionOf(account: Account): string {
  const raw = account.cushion == null ? null : Number(account.cushion);
  if (raw === null || !Number.isFinite(raw)) {
    // Falling back to the definition rather than showing nothing: it is
    // excess liquidity over net liquidation either way.
    const excess = Number(account.excess_liquidity);
    const net = Number(account.net_liquidation);
    if (!Number.isFinite(excess) || !Number.isFinite(net) || net === 0) return "—";
    return `${Math.round((excess / net) * 100)}%`;
  }
  return `${Math.round(raw * 100)}%`;
}

function dayTradesOf(account: Account): string {
  const raw = account.day_trades_remaining == null ? null : Number(account.day_trades_remaining);
  if (raw === null || !Number.isFinite(raw)) return "—";
  // IBKR sends -1 for unlimited, which is not a number of trades.
  return raw < 0 ? "∞" : String(Math.trunc(raw));
}

/** The account's name, falling back to the number when it has none. */
export function accountName(account: { account_id: string; label?: string }) {
  return account.label?.trim() || account.account_id;
}

export function BalancePanel({ account, canRename, onRename }: {
  account: Account;
  canRename?: boolean;
  onRename?: (label: string) => void;
}) {
  const low = (() => {
    const text = cushionOf(account);
    const value = Number(text.replace("%", ""));
    return Number.isFinite(value) && value < 25;
  })();
  return (
    <section className="panel">
      <h2>
        {accountName(account)} · balance &amp; margin
        <span>
          {account.label ? `${account.account_id} · ` : ""}{account.currency}
          {canRename && (
            <button
              type="button"
              className="rename"
              title="Name this account"
              onClick={() => {
                // A prompt rather than an inline form: renaming happens once,
                // and a permanent edit affordance on a risk panel is clutter.
                const next = window.prompt("Name for this account", account.label ?? "");
                if (next !== null) onRename?.(next.trim());
              }}
            >
              {account.label ? "Rename" : "Add a name"}
            </button>
          )}
        </span>
      </h2>
      <div className="balance-grid">
        {FIELDS.map(field => (
          <div key={String(field.key)}>
            <label>{field.title}</label>
            <small>{field.detail}</small>
            <strong>{money(account[field.key] as string)}</strong>
          </div>
        ))}
        <div className={low ? "negative" : ""}>
          <label>Cushion</label>
          <small>Excess liquidity ÷ net liq. Lower = closer to a margin call.</small>
          <strong>{cushionOf(account)}</strong>
        </div>
        <div>
          <label>Day trades</label>
          <small>Day trades remaining (5-day window). ∞ = unlimited.</small>
          <strong>{dayTradesOf(account)}</strong>
        </div>
      </div>
    </section>
  );
}
