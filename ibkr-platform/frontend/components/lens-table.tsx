"use client";

import { Fragment, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { spotLabel } from "@/lib/payoff";
import { breachClass, Lens, LensRow, percentOf } from "@/lib/risk-lenses";
import { cellClass, Column } from "@/lib/scenario-columns";
import { Sparkline } from "./sparkline";
import { Amount, money } from "./tables";
import { Term } from "./term";

export type Denomination = "money" | "pct";

export type UnpricedGroup = { key: string; positions: { account_id: string; con_id: number }[]; marketValue: number };

export const TOTAL_ROW = "total";

function Cell({ value, nlv, denomination, title }: { value: number | undefined; nlv: number | null; denomination: Denomination; title?: string }) {
  if (value === undefined || !Number.isFinite(value)) return <span className="muted">—</span>;
  if (denomination === "pct") {
    const pct = percentOf(value, nlv);
    if (pct === null) return <span className="muted" title="Net liquidation is not known in this currency">—</span>;
    return (
      <span className={`pct ${breachClass(pct)} ${pct < 0 ? "negative" : pct > 0 ? "positive" : ""}`} title={title ?? money(String(value))}>
        {pct > 0 ? "+" : ""}{pct.toFixed(1)}%
      </span>
    );
  }
  return <span title={title}><Amount value={String(value)} /></span>;
}

function RowHead({ row, meta, expanded, onToggle, strong }: { row: { id: string; label: string }; meta: ReactNode; expanded: boolean; onToggle: () => void; strong?: boolean }) {
  return (
    <th scope="row">
      <button type="button" className="row-toggle" aria-expanded={expanded} onClick={onToggle}>
        <ChevronRight size={14} aria-hidden="true" className="chev" />
        <span className="row-name">
          {strong ? <b>{row.label}</b> : <span>{row.label}</span>}
          <small>{meta}</small>
        </span>
      </button>
    </th>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function rowMeta(lens: Lens, row: LensRow): string {
  const legs = plural(row.legs.length, "leg");
  if (lens === "asset") return `terminal · ${legs} · ${plural(row.accounts.length, "account")}`;
  if (lens === "expiry") return `terminal · ${legs} · ${plural(row.keys.length, "name")}`;
  return `terminal · ${legs} · ${plural(row.keys.length, "name")}`;
}

export function LensTable({
  lens, currency, columns, rows, total, totalLabel, realized, showLevelRow, levelFor, expanded, onExpand, moveColumn,
  denomination, unpriced, renderDetail, captionNotes,
}: {
  lens: Lens;
  currency: string;
  columns: Column[];
  rows: LensRow[];
  total: LensRow;
  totalLabel: string;
  realized: { open: Record<number, number>; booked: number; charged: number };
  showLevelRow: boolean;
  levelFor: (shock: number) => ReactNode;
  expanded: string | null;
  onExpand: (id: string | null) => void;
  moveColumn: (id: string, delta: -1 | 1) => void;
  denomination: Denomination;
  unpriced: UnpricedGroup[];
  renderDetail: (row: LensRow | null) => ReactNode;
  captionNotes: string[];
}) {
  const shownColumns = columns.filter(column => column.shock in total.at);
  const span = shownColumns.length + (lens === "asset" ? 5 : 4);
  const toggle = (id: string) => onExpand(expanded === id ? null : id);
  const buckets = new Set(rows.map(row => row.bucket));
  const showBuckets = lens === "expiry" && buckets.size > 1;
  const firstInBucket = new Set(
    rows
      .filter((row, index) => showBuckets && row.bucket && (index === 0 || rows[index - 1].bucket !== row.bucket))
      .map(row => row.id),
  );

  const numberCells = (row: LensRow, isTotal = false) => (
    <>
      <td className="now"><Cell value={row.now} nlv={row.nlv} denomination={denomination} /></td>
      {shownColumns.map(column => (
        <td key={column.id} className={cellClass(column)}>
          <Cell
            value={row.at[column.shock]}
            nlv={row.nlv}
            denomination={denomination}
            title={row.reference ? `${row.label} at ${money(String(row.reference.price * (1 + column.shock / 100)))}` : undefined}
          />
        </td>
      ))}
      <td className="worst"><Cell value={row.worst} nlv={row.nlv} denomination={denomination} /></td>
      <td className="shape" title={`Payoff shape across the plotted range${isTotal ? "" : ` for ${row.label}`}`}>
        <Sparkline values={row.spark} label={`Payoff shape for ${row.label}`} />
      </td>
    </>
  );

  return (
    <div className="risk-table lens-table">
      <table className="scenario-grid lens-grid">
        <caption>
          RMS by {lens === "account" ? "account ID" : lens === "asset" ? "underlying" : "expiry"} · Scenario P&amp;L ({currency})
          {captionNotes.map(note => ` · ${note}`).join("")}
        </caption>
        <thead>
          <tr>
            <th scope="col">Measure</th>
            {lens === "asset" && <th scope="col" className="ref">Reference</th>}
            <th scope="col" className="now">
              <Term hint="Live mark-to-market at the current reference (0% move), including any booked adjustments.">MTM</Term>
            </th>
            {shownColumns.map((column, index) => (
              <th key={column.id} scope="col" className={cellClass(column)} aria-label={column.label}>
                <span className="col-head">
                  {column.label}
                  {shownColumns.length > 1 && <span className="col-move">
                    <button type="button" aria-label={`Move ${column.label} left`}
                      disabled={index === 0} onClick={() => moveColumn(column.id, -1)}>‹</button>
                    <button type="button" aria-label={`Move ${column.label} right`}
                      disabled={index === shownColumns.length - 1} onClick={() => moveColumn(column.id, 1)}>›</button>
                  </span>}
                </span>
              </th>
            ))}
            <th scope="col" className="worst">
              <Term hint="Lowest settlement P&L anywhere in the plotted range. Widen the range to test a deeper move.">Worst</Term>
            </th>
            <th scope="col" className="shape"><span className="sr-only">Payoff shape</span></th>
          </tr>
        </thead>
        <tbody>
          {showLevelRow && (
            <tr className="level-row">
              <th scope="row">Scenario underlying level</th>
              {lens === "asset" && <td className="ref" />}
              <td className="now muted">{levelFor(0)}</td>
              {shownColumns.map(column => <td key={column.id} className={cellClass(column)}>{levelFor(column.shock)}</td>)}
              <td className="worst" /><td className="shape" />
            </tr>
          )}
          {(realized.booked !== 0 || realized.charged !== 0) && (
            <>
              <tr>
                <th scope="row">Open legs, as broker reports</th>
                {lens === "asset" && <td className="ref" />}
                <td className="now"><Cell value={total.now - total.adjustment} nlv={total.nlv} denomination={denomination} /></td>
                {shownColumns.map(column => <td key={column.id} className={cellClass(column)}><Cell value={realized.open[column.shock]} nlv={total.nlv} denomination={denomination} /></td>)}
                <td className="worst" /><td className="shape" />
              </tr>
              {realized.booked !== 0 && <tr className="booked">
                <th scope="row">Booked P&amp;L (closed legs)</th>
                {lens === "asset" && <td className="ref" />}
                <td className="now"><Cell value={realized.booked} nlv={total.nlv} denomination={denomination} /></td>
                {shownColumns.map(column => <td key={column.id} className={cellClass(column)}><Cell value={realized.booked} nlv={total.nlv} denomination={denomination} /></td>)}
                <td className="worst" /><td className="shape" />
              </tr>}
              {realized.charged !== 0 && <tr className="booked">
                <th scope="row">Commissions</th>
                {lens === "asset" && <td className="ref" />}
                <td className="now"><Cell value={realized.charged} nlv={total.nlv} denomination={denomination} /></td>
                {shownColumns.map(column => <td key={column.id} className={cellClass(column)}><Cell value={realized.charged} nlv={total.nlv} denomination={denomination} /></td>)}
                <td className="worst" /><td className="shape" />
              </tr>}
            </>
          )}
          <tr className="total">
            <RowHead row={{ id: TOTAL_ROW, label: totalLabel }} meta={`terminal · ${plural(total.legs.length, "leg")}`} strong expanded={expanded === TOTAL_ROW} onToggle={() => toggle(TOTAL_ROW)} />
            {lens === "asset" && <td className="ref muted">{total.keys.length === 1 ? money(String(total.reference?.price)) : `${total.keys.length} names`}</td>}
            {numberCells(total, true)}
          </tr>
          {expanded === TOTAL_ROW && <tr className="detail"><td colSpan={span}>{renderDetail(null)}</td></tr>}
          <tr className="estimate">
            <th scope="row">Pre-expiry estimate</th>
            {lens === "asset" && <td className="ref" />}
            <td className="now"><Cell value={total.now} nlv={total.nlv} denomination={denomination} /></td>
            {shownColumns.map(column => <td key={column.id} className={cellClass(column)}><Cell value={total.estimate[column.shock]} nlv={total.nlv} denomination={denomination} /></td>)}
            <td className="worst" /><td className="shape" />
          </tr>
          {rows.map(row => {
            const bucketHead = firstInBucket.has(row.id)
              ? <tr className="bucket" key={`bucket:${row.bucket}`}><th colSpan={span} scope="colgroup">{row.bucket}</th></tr>
              : null;
            const open = expanded === row.id;
            return (
              <Fragment key={row.id}>
                {bucketHead}
                <tr className={`group${open ? " open" : ""}`}>
                  <RowHead row={row} meta={rowMeta(lens, row)} expanded={open} onToggle={() => toggle(row.id)} />
                  {lens === "asset" && (
                    <td className="ref">
                      {row.reference
                        ? <span className="ref-cell"><span>{money(String(row.reference.price))}</span><small>{spotLabel(row.reference.source)}</small></span>
                        : <span className="muted">—</span>}
                    </td>
                  )}
                  {numberCells(row)}
                </tr>
                {open && <tr className="detail"><td colSpan={span}>{renderDetail(row)}</td></tr>}
              </Fragment>
            );
          })}
          {lens === "asset" && unpriced.length > 0 && (
            <>
              <tr className="bucket unpriced"><th colSpan={span} scope="colgroup">Unpriced — no broker reference, not modeled</th></tr>
              {unpriced.map(group => (
                <tr key={group.key} className="group unpriced">
                  <th scope="row">
                    <span className="row-toggle static">
                      <span className="row-name">
                        <span>{group.key.split(":").at(-1)}</span>
                        <small>{plural(group.positions.length, "position")}</small>
                      </span>
                    </span>
                  </th>
                  <td className="ref muted">—</td>
                  <td colSpan={span - 2} className="note" role="status">
                    No broker reference price for {group.key}
                    {group.marketValue !== 0 && <> · market value {money(String(group.marketValue))}</>}
                  </td>
                </tr>
              ))}
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}
