"use client";
import { ReactNode, useMemo, useRef, useState } from "react";
import Decimal from "decimal.js";
import { Account, Execution, Money, Order, Position } from "@/lib/types";
import { SearchableSelect } from "./searchable-select";
import { useZone } from "./timezone";
import { formatDateTime, formatTime } from "@/lib/timezone";

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
type Facet<T> = { label: string; value: (row: T) => string | null | undefined };

const ANY = "All";
const MIN_COLUMN = 64;

export function DataTable<T>({
  rows,
  columns,
  id,
  onRow,
  facets = [],
  toolbar,
}: {
  rows: T[];
  columns: Column<T>[];
  id: (row: T) => string;
  onRow?: (row: T) => void;
  facets?: Facet<T>[];
  /** Controls belonging to this table, shown beside its search box. */
  toolbar?: ReactNode;
}) {
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ index: number; asc: boolean }>({
    index: 0,
    asc: true,
  });
  const [widths, setWidths] = useState<Record<string, number>>({});
  const drag = useRef<{ label: string; startX: number; startWidth: number } | null>(null);
  const head = useRef<HTMLTableRowElement>(null);

  const choices = useMemo(
    () =>
      Object.fromEntries(
        facets.map((facet) => [
          facet.label,
          [ANY, ...[...new Set(rows.map((row) => facet.value(row)).filter((v): v is string => !!v))].sort()],
        ]),
      ),
    [facets, rows],
  );

  const visible = useMemo(
    () =>
      rows
        .filter((row) =>
          facets.every((facet) => {
            const want = picked[facet.label];
            return !want || want === ANY || facet.value(row) === want;
          }),
        )
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
    [rows, columns, search, sort, facets, picked],
  );

  function seed() {
    if (Object.keys(widths).length || !head.current) return {} as Record<string, number>;
    const measured: Record<string, number> = {};
    head.current.querySelectorAll("th").forEach((cell, index) => {
      const label = columns[index]?.label;
      if (label) measured[label] = cell.getBoundingClientRect().width;
    });
    return measured;
  }
  return (
    <>
      <div className="table-toolbar">
        <input
          aria-label="Search table"
          placeholder="Search / filter…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {/* A table's own controls belong on its toolbar, beside the search, not
            stranded on a line above it. */}
        {toolbar}
        {facets.map((facet) => (
          <label key={facet.label} className="table-facet">
            <span>{facet.label}</span>
            <SearchableSelect
              label={facet.label}
              value={picked[facet.label] ?? ANY}
              options={choices[facet.label] ?? [ANY]}
              onChange={(next) =>
                setPicked((current) => ({ ...current, [facet.label]: next }))
              }
            />
          </label>
        ))}
        <div>
          <span className="mobile-sort">
            <SearchableSelect
              label="Sort by"
              value={columns[sort.index]?.label ?? ""}
              options={columns.map((col) => col.label)}
              onChange={(label) =>
                setSort({
                  index: Math.max(0, columns.findIndex((col) => col.label === label)),
                  asc: sort.asc,
                })
              }
            />
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
        <table
          className={`responsive-table ${Object.keys(widths).length ? "sized" : ""}`}
        >
          <colgroup>
            {columns.map((col) => (
              <col
                key={col.label}
                style={widths[col.label] ? { width: widths[col.label] } : undefined}
              />
            ))}
          </colgroup>
          <thead>
            <tr ref={head}>
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
                    className="th-sort"
                    title={`Sort by ${col.label}`}
                    onClick={() =>
                      setSort({
                        index,
                        asc: sort.index === index ? !sort.asc : true,
                      })
                    }
                  >
                    <span className="th-label">{col.label}</span>
                    <span aria-hidden="true" className={`th-arrow ${sort.index === index ? "on" : ""}`}>
                      {sort.index === index ? (sort.asc ? "↑" : "↓") : "↕"}
                    </span>
                  </button>
                  <span
                    className="th-grip"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${col.label} column`}
                    tabIndex={0}
                    title="Drag to resize · double-click to reset"
                    onDoubleClick={() =>
                      setWidths((current) => {
                        const next = { ...current };
                        delete next[col.label];
                        return next;
                      })
                    }
                    onKeyDown={(event) => {
                      const step =
                        event.key === "ArrowRight" ? 16 : event.key === "ArrowLeft" ? -16 : 0;
                      if (!step) return;
                      event.preventDefault();
                      const cells = head.current?.querySelectorAll("th");
                      const measured = seed();
                      const from =
                        widths[col.label] ??
                        measured[col.label] ??
                        cells?.[index]?.getBoundingClientRect().width ??
                        MIN_COLUMN;
                      setWidths((current) => ({
                        ...current,
                        ...measured,
                        [col.label]: Math.max(MIN_COLUMN, from + step),
                      }));
                    }}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      const cell = event.currentTarget.parentElement as HTMLElement;
                      const measured = seed();
                      if (Object.keys(measured).length) setWidths(measured);
                      drag.current = {
                        label: col.label,
                        startX: event.clientX,
                        startWidth: cell.getBoundingClientRect().width,
                      };
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      const grabbed = drag.current;
                      if (!grabbed) return;
                      const next = Math.max(
                        MIN_COLUMN,
                        grabbed.startWidth + (event.clientX - grabbed.startX),
                      );
                      setWidths((current) => ({ ...current, [grabbed.label]: next }));
                    }}
                    onPointerUp={(event) => {
                      drag.current = null;
                      event.currentTarget.releasePointerCapture(event.pointerId);
                    }}
                  />
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
/** An account's name, falling back to its number. Kept here as well as in the
 *  balance panel so every table that lists accounts agrees. */
export function accountLabel(row: { account_id: string; label?: string }) {
  return row.label?.trim() || row.account_id;
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
              {accountLabel(r)}
              {/* The number stays visible beneath the name: it is what IBKR,
                  the statements and support all use. */}
              <small>{r.label ? `${r.account_id} · ${r.currency}` : r.currency}</small>
            </button>
          ),
          // Sorted and searched by both, so typing either finds the row.
          value: (r) => `${accountLabel(r)} ${r.account_id}`,
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
const expiryLabel = (value: string) =>
  /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value;

export function PositionsTable({ rows }: { rows: Position[] }) {
  return (
    <DataTable
      rows={rows}
      id={(r) => `${r.account_id}:${r.con_id}`}
      facets={[
        { label: "Account", value: (r) => r.account_id },
        { label: "Type", value: (r) => r.sec_type },
        { label: "Right", value: (r) => (r.right === "C" ? "Call" : r.right === "P" ? "Put" : "") },
        { label: "Expiry", value: (r) => (r.expiry ? expiryLabel(r.expiry) : "") },
        { label: "Currency", value: (r) => r.currency },
        {
          label: "Side",
          value: (r) => (Number(r.quantity) < 0 ? "Short" : Number(r.quantity) > 0 ? "Long" : "Flat"),
        },
      ]}
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
  const zone = useZone();
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
          render: (r) => formatTime(r.updated_at, zone),
          value: (r) => r.updated_at,
        },
      ]}
    />
  );
}
export function netRate(row: Execution): string | null {
  const price = Number(row.price);
  const commission = row.commission == null ? null : Number(row.commission);
  const units = Number(row.quantity) * Number(row.multiplier ?? 1);
  if (commission === null || !Number.isFinite(price) || !Number.isFinite(units) || units === 0) return null;
  const perUnit = Math.abs(commission) / Math.abs(units);
  return String(price + (row.side === "BOT" ? perUnit : -perUnit));
}

export function ExecutionsTable({ rows }: { rows: Execution[] }) {
  const zone = useZone();
  const [withCommissions, setWithCommissions] = useState(false);
  return (
    <DataTable
      toolbar={
        <label className="commission-toggle table-toggle">
          <input type="checkbox" checked={withCommissions} onChange={(e) => setWithCommissions(e.target.checked)} />
          <span>Include commissions in traded rate</span>
        </label>
      }
      rows={rows}
      id={(r) => r.execution_id}
      columns={[
        {
          label: "Time",
          render: (r) => formatDateTime(r.executed_at, zone),
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
          label: withCommissions ? "Traded rate (net)" : "Traded rate (gross)",
          render: (r) => money(withCommissions ? netRate(r) ?? r.price : r.price),
          value: (r) => (withCommissions ? netRate(r) ?? r.price : r.price),
        },
        {
          label: "Commission",
          render: (r) => money(r.commission),
          value: (r) => r.commission ?? null,
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
