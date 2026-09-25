"use client";

import { useState } from "react";

export type Selection = {
  options: string[];
  selected: string[];
  isAll: boolean;
  isNone: boolean;
  summary: string;
  has: (value: string) => boolean;
  toggle: (value: string) => void;
  selectAll: () => void;
  clear: () => void;
};

/** Closed-dropdown text: the chosen labels, not "2 of 5". */
export function summarizeChoices(values: string[], limit = 3): string {
  if (!values.length) return "None";
  if (values.length <= limit) return values.join(", ");
  return `${values.slice(0, limit).join(", ")} +${values.length - limit}`;
}

export function useSelection(options: string[]): Selection {
  const [picked, setPicked] = useState<string[] | null>(null);
  const live = picked === null ? null : picked.filter(value => options.includes(value));
  const stale = picked !== null && picked.length > 0 && live !== null && live.length === 0;
  const selected = live === null || stale ? options : live;
  const isAll = selected.length === options.length;
  const isNone = selected.length === 0 && options.length > 0;
  return {
    options,
    selected,
    isAll,
    isNone,
    summary: isAll ? `All ${options.length}` : isNone ? "None" : `${selected.length} of ${options.length}`,
    has: value => selected.includes(value),
    toggle: value => {
      const next = selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value];
      setPicked(next.length === options.length ? null : next);
    },
    selectAll: () => setPicked(null),
    clear: () => setPicked([]),
  };
}

/** Each list shows only values that still exist under the other lists' current picks. */
export function useCrossSelection<T>(
  items: T[],
  dims: Record<string, (item: T) => string>,
  sort: Record<string, (a: string, b: string) => number> = {},
): Record<string, Selection> {
  const [picked, setPicked] = useState<Record<string, string[] | null>>({});
  const names = Object.keys(dims);

  const selectionFor = (dim: string): Selection => {
    const options = [...new Set(items.filter(item => names.every(other => {
      if (other === dim) return true;
      const want = picked[other];
      return want == null || want.includes(dims[other](item));
    })).map(item => dims[dim](item)).filter(Boolean))].sort(sort[dim] ?? ((a, b) => a.localeCompare(b)));
    const raw = picked[dim] ?? null;
    const live = raw === null ? null : raw.filter(value => options.includes(value));
    const stale = raw !== null && raw.length > 0 && live !== null && live.length === 0;
    const selected = live === null || stale ? options : live;
    const isAll = selected.length === options.length;
    const isNone = selected.length === 0 && options.length > 0;
    return {
      options,
      selected,
      isAll,
      isNone,
      summary: isAll ? `All ${options.length}` : isNone ? "None" : `${selected.length} of ${options.length}`,
      has: value => selected.includes(value),
      toggle: value => {
        const next = selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value];
        setPicked(prev => ({ ...prev, [dim]: next.length === options.length ? null : next }));
      },
      selectAll: () => setPicked(prev => ({ ...prev, [dim]: null })),
      clear: () => setPicked(prev => ({ ...prev, [dim]: [] })),
    };
  };

  return Object.fromEntries(names.map(dim => [dim, selectionFor(dim)]));
}

export function SelectionActions({ selection, noun }: { selection: Selection; noun: string }) {
  return (
    <div className="selection-actions">
      <button type="button" aria-label={`Select all ${noun}`} onClick={selection.selectAll} disabled={selection.isAll}>
        Select all
      </button>
      <button type="button" aria-label={`Clear ${noun}`} onClick={selection.clear} disabled={selection.isNone || !selection.options.length}>
        Clear
      </button>
    </div>
  );
}
