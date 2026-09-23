"use client";
import { Fragment, ReactNode, useCallback, useMemo, useRef, useState } from "react";
import Decimal from "decimal.js";
import { Account, Execution, Money, Order, Position } from "@/lib/types";
import {
  Fill,
  cashFlow,
  commission,
  contract,
  expired,
  expiryShort,
  groupFills,
  instrument,
  isBuy,
  netRate,
  quantity,
  realized,
} from "@/lib/executions";
import { SearchableSelect } from "./searchable-select";
import { TableRowsSkeleton } from "./skeleton";
import { useZone } from "./timezone";
import { formatDay, formatTime } from "@/lib/timezone";

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
  className?: string;
};
type Facet<T> = { label: string; value: (row: T) => string | null | undefined };

const ANY = "All";
const JSON_TEXT = (row: unknown) => JSON.stringify(row);
const MIN_COLUMN = 64;

export function DataTable<T>({
  rows,
  columns,
  id,
  onRow,
  facets = [],
  toolbar,
  initialSort = { index: 0, asc: true },
  searchText = JSON_TEXT,
  summary,
  groupBy,
  groupSummary,
  rowClassName,
  loading = false,
}: {
  rows: T[];
  columns: Column<T>[];
  id: (row: T) => string;
  onRow?: (row: T) => void;
  facets?: Facet<T>[];

  toolbar?: ReactNode;
  initialSort?: { index: number; asc: boolean };
  searchText?: (row: T) => string;
  summary?: (visible: T[]) => ReactNode;
  // Group header rows only make sense while the rows are ordered by the
  // column the groups come from, so they appear when sorting by column 0.
  groupBy?: (row: T) => string;
  groupSummary?: (rows: T[]) => ReactNode;
  rowClassName?: (row: T) => string;
  loading?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ index: number; asc: boolean }>(initialSort);
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
          searchText(row).toLowerCase().includes(search.toLowerCase()),
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
    [rows, columns, search, sort, facets, picked, searchText],
  );

  const groups = useMemo(() => {
    if (!groupBy || sort.index !== 0) return [{ label: "", rows: visible }];
    const runs: { label: string; rows: T[] }[] = [];
    for (const row of visible) {
      const label = groupBy(row);
      const last = runs[runs.length - 1];
      if (last && last.label === label) last.rows.push(row);
      else runs.push({ label, rows: [row] });
    }
    return runs;
  }, [visible, groupBy, sort.index]);
  const filtered = !!search || Object.values(picked).some((v) => v && v !== ANY);

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

        {toolbar}
        {facets
          .filter(
            (facet) =>
              (choices[facet.label]?.length ?? 0) > 2 ||
              (picked[facet.label] ?? ANY) !== ANY,
          )
          .map((facet) => (
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
          {filtered && (
            <button
              type="button"
              className="table-clear"
              onClick={() => {
                setSearch("");
                setPicked({});
              }}
            >
              Clear filters
            </button>
          )}
          <span>
            {loading && !rows.length
              ? "Loading…"
              : `${filtered ? `${visible.length} of ${rows.length}` : visible.length} records`}
          </span>
        </div>
      </div>
      {summary && rows.length > 0 && summary(visible)}
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
                  className={col.className}
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
          <tbody aria-busy={loading && !rows.length}>
            {loading && !rows.length && <TableRowsSkeleton columns={columns.length} />}
            {groups.map((group) => (
              <Fragment key={group.label || "all"}>
                {group.label && (
                  <tr className="group-row">
                    <th scope="colgroup" colSpan={columns.length}>
                      <span>{group.label}</span>
                      {groupSummary?.(group.rows)}
                    </th>
                  </tr>
                )}
                {group.rows.map((row) => (
                  <tr
                    key={id(row)}
                    onClick={() => onRow?.(row)}
                    className={[onRow ? "clickable" : "", rowClassName?.(row) ?? ""].join(" ").trim() || undefined}
                  >
                    {columns.map((col) => (
                      <td key={col.label} data-label={col.label} className={col.className}>
                        {col.render(row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
        {!visible.length && !(loading && !rows.length) && (
          <div className="empty">
            {rows.length ? "No records match these filters" : "No records in this view"}
          </div>
        )}
      </div>
    </>
  );
}

export function accountLabel(row: { account_id: string; label?: string }) {
  return row.label?.trim() || row.account_id;
}

export function AccountsTable({
  rows,
  onRow,
  loading,
}: {
  rows: Account[];
  onRow: (row: Account) => void;
  loading?: boolean;
}) {
  return (
    <DataTable
      loading={loading}
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

              <small>{r.label ? `${r.account_id} · ${r.currency}` : r.currency}</small>
            </button>
          ),

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
          label: "Margin blocked",
          render: (r) => money(r.initial_margin),
          value: (r) => r.initial_margin,
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

export function PositionsTable({ rows, loading }: { rows: Position[]; loading?: boolean }) {
  return (
    <DataTable
      loading={loading}
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
export function OrdersTable({ rows, loading }: { rows: Order[]; loading?: boolean }) {
  const zone = useZone();
  return (
    <DataTable
      loading={loading}
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

const signed = (value: number | null) =>
  value === null ? "—" : `${value > 0 ? "+" : ""}${money(String(value))}`;
const fillDay = (zone: ReturnType<typeof useZone>) => (fill: Fill) =>
  formatDay(fill.lead.executed_at, zone);

function Side({ fill }: { fill: Fill }) {
  if (expired(fill)) return <span className="side expired">Expired</span>;
  if (fill.combo) {
    const credit = (cashFlow(fill) ?? 0) > 0;
    return (
      <span
        className={`side ${credit ? "sell" : "buy"}`}
        title={`Combo ${isBuy(fill.lead) ? "bought" : "sold"} at ${fill.lead.price}`}
      >
        {credit ? "Credit" : "Debit"}
      </span>
    );
  }
  const buy = isBuy(fill.lead);
  return <span className={`side ${buy ? "buy" : "sell"}`}>{buy ? "Buy" : "Sell"}</span>;
}

function Leg({ row }: { row: Execution }) {
  const { name, detail } = contract(row);
  return (
    <li>
      <span className={isBuy(row) ? "buy" : "sell"}>
        {isBuy(row) ? "+" : "−"}
        {quantity(row.quantity)}
      </span>{" "}
      {name}
      {detail && <em>{detail}</em>}
      <b>@ {money(row.price)}</b>
    </li>
  );
}

function Totals({ fills }: { fills: Fill[] }) {
  let bought = 0,
    sold = 0,
    net = 0,
    fees = 0,
    pnl = 0,
    pending = 0,
    lapsed = 0;
  for (const fill of fills) {
    const qty = Number(fill.lead.quantity) || 0;
    if (expired(fill)) lapsed += qty;
    else if (isBuy(fill.lead)) bought += qty;
    else sold += qty;
    net += cashFlow(fill) ?? 0;
    const paid = commission(fill);
    if (paid === null) pending += 1;
    else fees += paid;
    pnl += realized(fill) ?? 0;
  }
  const combos = fills.filter((f) => f.combo).length;
  return (
    <div className="exec-totals" aria-label="Totals for the executions shown">
      <div>
        <label>Fills</label>
        <strong>{fills.length.toLocaleString()}</strong>
        <small>{combos ? `${combos} combo${combos === 1 ? "" : "s"}` : "no combos"}</small>
      </div>
      <div>
        <label>Bought / sold</label>
        <strong>
          <span className="buy">{quantity(String(bought))}</span>
          <span className="muted"> / </span>
          <span className="sell">{quantity(String(sold))}</span>
        </strong>
        <small>{lapsed ? `${quantity(String(lapsed))} expired · combos count once` : "a combo counts once"}</small>
      </div>
      <div>
        <label>Net premium</label>
        <strong className={net > 0 ? "positive" : net < 0 ? "negative" : ""}>{signed(net)}</strong>
        <small>{net >= 0 ? "net credit" : "net debit"}</small>
      </div>
      <div>
        <label>Commission</label>
        <strong>{money(String(fees))}</strong>
        <small className={pending ? "warn" : ""}>
          {pending ? `${pending} fill${pending === 1 ? "" : "s"} awaiting report` : "all reported"}
        </small>
      </div>
      <div>
        <label>Realized P&amp;L</label>
        <strong className={pnl > 0 ? "positive" : pnl < 0 ? "negative" : ""}>{signed(pnl)}</strong>
        <small>on closing fills</small>
      </div>
    </div>
  );
}

function DayTotals({ fills }: { fills: Fill[] }) {
  const fees = fills.reduce((a, f) => a + (commission(f) ?? 0), 0);
  const pnl = fills.reduce((a, f) => a + (realized(f) ?? 0), 0);
  return (
    <span className="group-meta">
      <span>
        {fills.length} fill{fills.length === 1 ? "" : "s"}
      </span>
      <span>comm {money(String(fees))}</span>
      {pnl !== 0 && (
        <span className={pnl > 0 ? "positive" : "negative"}>realized {signed(pnl)}</span>
      )}
    </span>
  );
}

export function ExecutionsTable({
  rows,
  accounts = [],
  loading = false,
}: {
  rows: Execution[];
  accounts?: Account[];
  loading?: boolean;
}) {
  const zone = useZone();
  const [withCommissions, setWithCommissions] = useState(false);
  const fills = useMemo(() => groupFills(rows), [rows]);
  const labels = useMemo(
    () => Object.fromEntries(accounts.map((a) => [a.account_id, accountLabel(a)])),
    [accounts],
  );
  const account = useCallback((id: string) => labels[id] ?? id, [labels]);
  const rate = (fill: Fill) =>
    withCommissions ? netRate(fill) ?? Number(fill.lead.price) : Number(fill.lead.price);
  const day = useMemo(() => fillDay(zone), [zone]);
  const searchText = useCallback(
    (fill: Fill) =>
      [fill.lead, ...fill.legs]
        .map((row) => {
          const c = contract(row);
          return `${c.name} ${c.detail} ${row.symbol} ${row.underlying ?? ""} ${row.exchange} ${row.execution_id}`;
        })
        .concat(account(fill.lead.account_id), fill.lead.account_id, isBuy(fill.lead) ? "buy" : "sell", instrument(fill))
        .join(" "),
    [account],
  );

  return (
    <DataTable
      toolbar={
        <label className="commission-toggle table-toggle">
          <input type="checkbox" checked={withCommissions} onChange={(e) => setWithCommissions(e.target.checked)} />
          <span>Include commissions in traded rate</span>
        </label>
      }
      loading={loading}
      rows={fills}
      id={(f) => f.key}
      initialSort={{ index: 0, asc: false }}
      searchText={searchText}
      groupBy={day}
      groupSummary={(group) => <DayTotals fills={group} />}
      summary={(visible) => <Totals fills={visible} />}
      rowClassName={(f) => (f.combo ? "combo-row" : "")}
      facets={[
        { label: "Account", value: (f) => account(f.lead.account_id) },
        {
          label: "Side",
          value: (f) =>
            expired(f)
              ? "Expired"
              : f.combo
                ? (cashFlow(f) ?? 0) > 0
                  ? "Credit"
                  : "Debit"
                : isBuy(f.lead)
                  ? "Buy"
                  : "Sell",
        },
        { label: "Underlying", value: (f) => f.lead.underlying || f.lead.symbol.split(" ")[0] },
        {
          label: "Expiry",
          value: (f) => expiryShort(f.lead.expiry ?? f.legs[0]?.expiry ?? ""),
        },
        { label: "Instrument", value: instrument },
        { label: "Exchange", value: (f) => f.lead.exchange },
      ]}
      columns={[
        {
          label: "Time",
          className: "col-time",
          render: (f) => (
            <span title={`${formatDay(f.lead.executed_at, zone)} ${formatTime(f.lead.executed_at, zone)} · ${f.lead.execution_id}`}>
              {formatTime(f.lead.executed_at, zone)}
            </span>
          ),
          value: (f) => f.lead.executed_at,
        },
        {
          label: "Contract",
          className: "col-contract",
          render: (f) => {
            const { name, detail } = contract(f.lead);
            return (
              <div className="exec-contract">
                <span className="exec-name">
                  {name}
                  {detail && <em>{detail}</em>}
                  {f.combo && <span className="badge">{f.legs.length} legs</span>}
                </span>
                <small>
                  {account(f.lead.account_id)} · {f.lead.exchange}
                </small>
                {f.combo && f.legs.length > 0 && (
                  <ul className="exec-legs">
                    {f.legs.map((leg) => (
                      <Leg key={leg.execution_id} row={leg} />
                    ))}
                  </ul>
                )}
              </div>
            );
          },
          value: (f) => `${contract(f.lead).name} ${f.lead.executed_at}`,
        },
        {
          label: "Side",
          className: "col-side",
          render: (f) => <Side fill={f} />,
          value: (f) => (expired(f) ? "EXP" : f.lead.side),
        },
        {
          label: "Qty",
          render: (f) => quantity(f.lead.quantity),
          value: (f) => Number(f.lead.quantity),
        },
        {
          label: withCommissions ? "Rate (net)" : "Rate (gross)",
          render: (f) => money(String(rate(f))),
          value: (f) => rate(f),
        },
        {
          label: "Premium",
          render: (f) => {
            const value = cashFlow(f);
            return <span className={value === null ? "" : "muted-sign"}>{signed(value)}</span>;
          },
          value: (f) => cashFlow(f),
        },
        {
          label: "Commission",
          render: (f) => {
            const value = commission(f);
            return expired(f) ? (
              <span className="muted">—</span>
            ) : value === null ? (
              <span className="pending" title="IBKR has not reported the commission for this fill yet">
                pending
              </span>
            ) : (
              money(String(value))
            );
          },
          value: (f) => commission(f),
        },
        {
          label: "Realized P&L",
          render: (f) => {
            const value = realized(f);
            return value === null || value === 0 ? (
              <span className="muted">—</span>
            ) : (
              <Amount value={String(value)} />
            );
          },
          value: (f) => realized(f),
        },
      ]}
    />
  );
}
