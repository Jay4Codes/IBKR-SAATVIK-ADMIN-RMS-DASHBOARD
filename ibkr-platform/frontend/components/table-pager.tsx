"use client";

import { useState } from "react";

export const PAGE_SIZE = 10;

export function pageList(page: number, pages: number): (number | "gap")[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i);
  const keep = new Set([0, pages - 1, page - 1, page, page + 1]);
  const sorted = [...keep].filter((n) => n >= 0 && n < pages).sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  for (const n of sorted) {
    const prev = out.at(-1);
    if (typeof prev === "number" && n - prev > 1) out.push("gap");
    out.push(n);
  }
  return out;
}

export function usePagedRows<T>(rows: T[], resetKey = "") {
  const [page, setPage] = useState(0);
  const [seen, setSeen] = useState(resetKey);
  if (seen !== resetKey) {
    setSeen(resetKey);
    setPage(0);
  }
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const start = current * PAGE_SIZE;
  return {
    page: current,
    pages,
    total: rows.length,
    start,
    rows: rows.slice(start, start + PAGE_SIZE),
    setPage,
  };
}

export function TablePager({
  page,
  pages,
  total,
  onPage,
}: {
  page: number;
  pages: number;
  total: number;
  onPage: (page: number) => void;
}) {
  if (total <= PAGE_SIZE) return null;
  const from = page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);
  return (
    <nav className="table-pager" aria-label="Pagination">
      <span>
        {from}–{to} of {total}
      </span>
      <div>
        <button type="button" onClick={() => onPage(page - 1)} disabled={page === 0}>
          Previous
        </button>
        {pageList(page, pages).map((item, index) =>
          item === "gap" ? (
            <span key={`gap-${index}`} className="gap" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={item}
              type="button"
              aria-label={`Page ${item + 1}`}
              aria-current={item === page ? "page" : undefined}
              onClick={() => onPage(item)}
            >
              {item + 1}
            </button>
          ),
        )}
        <button type="button" onClick={() => onPage(page + 1)} disabled={page >= pages - 1}>
          Next
        </button>
      </div>
    </nav>
  );
}
