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
