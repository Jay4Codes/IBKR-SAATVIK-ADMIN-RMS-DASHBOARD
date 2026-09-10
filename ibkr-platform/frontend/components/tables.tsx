"use client";
import { ReactNode, useMemo, useState } from "react";
import Decimal from "decimal.js";
import { Account, Execution, Money, Order, Position } from "@/lib/types";

export function money(value: Money | undefined, digits = 2) {
  if (value == null) return "—";
  return new Decimal(value)
    .toFixed(digits)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
export function Amount({ value }: { value: Money | undefined }) {
  const color =
    value == null
      ? ""
      : new Decimal(value).isNegative()
        ? "negative"
        : new Decimal(value).isZero()
          ? ""
          : "positive";
  return (
    <span key={value} className={`changed ${color}`}>
      {money(value)}
    </span>
  );
}
type Column<T> = {
  label: string;
  render: (row: T) => ReactNode;
  value?: (row: T) => string | number | null;
};
export function DataTable<T>({
  rows,
  columns,
  id,
  onRow,
}: {
  rows: T[];
  columns: Column<T>[];
  id: (row: T) => string;
  onRow?: (row: T) => void;
}) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ index: number; asc: boolean }>({
    index: 0,
    asc: true,
  });
  const visible = useMemo(
    () =>
      rows
        .filter((row) =>
          JSON.stringify(row).toLowerCase().includes(search.toLowerCase()),
        )
        .sort((a, b) => {
          const col = columns[sort.index];
          const av = col.value?.(a) ?? "",
            bv = col.value?.(b) ?? "";
          const numeric = /^-?\d+(\.\d+)?$/;
          const comparison =
            numeric.test(String(av)) && numeric.test(String(bv))
              ? new Decimal(av).cmp(new Decimal(bv))
              : String(av).localeCompare(String(bv));
          return comparison * (sort.asc ? 1 : -1);
        }),
    [rows, columns, search, sort],
  );
  return (
    <>
      <div className="table-toolbar">
        <input
          aria-label="Search table"
          placeholder="Search / filter…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div>
          <span className="mobile-sort">
            <select
              aria-label="Sort by"
              value={sort.index}
              onChange={(e) =>
                setSort({ index: Number(e.target.value), asc: sort.asc })
              }
            >
              {columns.map((col, index) => (
                <option key={col.label} value={index}>
                  {col.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label={
                sort.asc ? "Sort descending" : "Sort ascending"
              }
              onClick={() => setSort({ index: sort.index, asc: !sort.asc })}
            >
              {sort.asc ? "↑" : "↓"}
            </button>
          </span>
          <span>{visible.length} records</span>
        </div>
      </div>
      <div className="table-scroll">
        <table className="responsive-table">
          <thead>
            <tr>
              {columns.map((col, index) => (
                <th
                  key={col.label}
                  aria-sort={
                    sort.index === index
                      ? sort.asc
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <button
                    onClick={() =>
                      setSort({
                        index,
                        asc: sort.index === index ? !sort.asc : true,
                      })
                    }
                  >
                    {col.label}
                    {sort.index === index ? (sort.asc ? " ↑" : " ↓") : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr
                key={id(row)}
                onClick={() => onRow?.(row)}
                className={onRow ? "clickable" : ""}
              >
                {columns.map((col) => (
                  <td key={col.label} data-label={col.label}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!visible.length && (
          <div className="empty">No records in this view</div>
        )}
      </div>
    </>
  );
}
export function AccountsTable({
  rows,
  onRow,
}: {
  rows: Account[];
  onRow: (row: Account) => void;
}) {
  return (
    <DataTable
      rows={rows}
      id={(r) => r.account_id}
      onRow={onRow}
      columns={[
        {
          label: "Account",
          render: (r) => (
            <button
              className="account-link"
              onClick={(e) => {
                e.stopPropagation();
                onRow(r);
              }}
            >
              {r.account_id}
              <small>{r.currency}</small>
            </button>
          ),
          value: (r) => r.account_id,
        },
        {
          label: "Net liquidation",
          render: (r) => money(r.net_liquidation),
          value: (r) => r.net_liquidation,
        },
        {
          label: "Day P&L",
          render: (r) => <Amount value={r.day_pnl} />,
          value: (r) => r.day_pnl,
        },
        {
          label: "Unrealized P&L",
          render: (r) => <Amount value={r.unrealized_pnl} />,
          value: (r) => r.unrealized_pnl,
        },
        {
          label: "Available funds",
          render: (r) => money(r.available_funds),
          value: (r) => r.available_funds,
        },
        {
          label: "Excess liquidity",
          render: (r) => money(r.excess_liquidity),
          value: (r) => r.excess_liquidity,
        },
        {
          label: "Positions",
          render: (r) => r.open_positions,
          value: (r) => r.open_positions,
        },
        {
          label: "Orders",
          render: (r) => r.open_orders,
          value: (r) => r.open_orders,
        },
        {
          label: "Status",
          render: (r) => (
            <span className="badge">
              {Date.now() - Date.parse(r.updated_at) < 35000
                ? "CURRENT"
                : "STALE"}
            </span>
          ),
        },
      ]}
    />
  );
}
export function positionLabel(r: Position) {
  const expiry =
    r.expiry.length === 8
      ? `${r.expiry.slice(0, 4)}-${r.expiry.slice(4, 6)}-${r.expiry.slice(6)}`
      : r.expiry;
  return r.sec_type === "OPT" || r.sec_type === "FOP"
    ? `${r.symbol} ${expiry} ${r.strike ?? ""} ${r.right}`
    : r.local_symbol || r.symbol;
}
export function PositionsTable({ rows }: { rows: Position[] }) {
  return (
    <DataTable
      rows={rows}
      id={(r) => `${r.account_id}:${r.con_id}`}
      columns={[
        {
          label: "Symbol",
          render: (r) => (
            <span title={`conId ${r.con_id}`}>
              {positionLabel(r)}
              <small>
                {r.account_id} · {r.currency}
              </small>
            </span>
          ),
          value: (r) => r.symbol,
        },
        { label: "Type", render: (r) => r.sec_type, value: (r) => r.sec_type },
        {
          label: "Expiry",
          render: (r) => r.expiry || "—",
          value: (r) => r.expiry,
        },
        {
          label: "Strike",
          render: (r) => (r.right ? money(r.strike) : "—"),
          value: (r) => r.strike,
        },
        { label: "Right", render: (r) => r.right || "—" },
        { label: "Qty", render: (r) => r.quantity, value: (r) => r.quantity },
        {
          label: "Avg cost¹",
          render: (r) => money(r.average_cost),
          value: (r) => r.average_cost,
        },
        {
          label: "Mark",
          render: (r) => (
            <span key={r.market_price} className="changed">
              {money(r.market_price)}
            </span>
          ),
          value: (r) => r.market_price,
        },
        {
          label: "Market value",
          render: (r) => money(r.market_value),
          value: (r) => r.market_value,
        },
        {
          label: "Unrealized P&L",
          render: (r) => <Amount value={r.unrealized_pnl} />,
          value: (r) => r.unrealized_pnl,
        },
      ]}
    />
  );
}
export function OrdersTable({ rows }: { rows: Order[] }) {
  return (
    <DataTable
      rows={rows}
      id={(r) =>
        `${r.account_id}:${r.perm_id > 0 ? `perm:${r.perm_id}` : `${r.client_id}:${r.order_id}`}`
      }
      columns={[
        {
          label: "Order ID",
          render: (r) => r.order_id,
          value: (r) => r.order_id,
        },
        {
          label: "Symbol",
          render: (r) => (
            <>
              {r.symbol}
              <small>{r.account_id}</small>
            </>
          ),
          value: (r) => r.symbol,
        },
        { label: "Side", render: (r) => r.side, value: (r) => r.side },
        {
          label: "Type",
          render: (r) => r.order_type,
          value: (r) => r.order_type,
        },
        {
          label: "Quantity",
          render: (r) => r.quantity,
          value: (r) => r.quantity,
        },
        {
          label: "Filled",
          render: (r) => r.filled_quantity,
          value: (r) => r.filled_quantity,
        },
        {
          label: "Remaining",
          render: (r) => r.remaining_quantity,
          value: (r) => r.remaining_quantity,
        },
        {
          label: "Limit",
          render: (r) => money(r.limit_price),
          value: (r) => r.limit_price,
        },
        {
          label: "Status",
          render: (r) => (
            <span
              className={`badge ${r.status === "Filled" ? "positive" : r.status === "Inactive" ? "negative" : ""}`}
            >
              {r.status}
            </span>
          ),
          value: (r) => r.status,
        },
        {
          label: "Updated",
          render: (r) => new Date(r.updated_at).toLocaleTimeString(),
          value: (r) => r.updated_at,
        },
      ]}
    />
  );
}
export function ExecutionsTable({ rows }: { rows: Execution[] }) {
  return (
    <DataTable
      rows={rows}
      id={(r) => r.execution_id}
      columns={[
        {
          label: "Time",
          render: (r) => new Date(r.executed_at).toLocaleString(),
          value: (r) => r.executed_at,
        },
        {
          label: "Symbol",
          render: (r) => (
            <>
              {r.symbol}
              <small>{r.account_id}</small>
            </>
          ),
          value: (r) => r.symbol,
        },
        { label: "Side", render: (r) => r.side, value: (r) => r.side },
        {
          label: "Quantity",
          render: (r) => r.quantity,
          value: (r) => r.quantity,
        },
        {
          label: "Price",
          render: (r) => money(r.price),
          value: (r) => r.price,
        },
        {
          label: "Exchange",
          render: (r) => r.exchange,
          value: (r) => r.exchange,
        },
        {
          label: "Order ID",
          render: (r) => r.order_id,
          value: (r) => r.order_id,
        },
      ]}
    />
  );
}
