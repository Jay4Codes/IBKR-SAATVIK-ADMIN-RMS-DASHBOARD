"use client";

import { useState } from "react";
import { Dropdown } from "./dropdown";
import { Selection, SelectionActions, summarizeChoices } from "./selection";

export function SearchableMultiSelect({
  label,
  selection,
  noun,
  searchFrom = 7,
  describe,
  format = value => value,
  className,
}: {
  label: string;
  selection: Selection;
  noun: string;
  searchFrom?: number;
  describe?: (value: string) => string;
  format?: (value: string) => string;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const searchable = selection.options.length >= searchFrom;
  const needle = query.trim().toLowerCase();
  const shown = !searchable || !needle
    ? selection.options
    : selection.options.filter(option => {
        const extra = describe?.(option) ?? "";
        return option.toLowerCase().includes(needle) || format(option).toLowerCase().includes(needle) || extra.toLowerCase().includes(needle);
      });

  const value = summarizeChoices(selection.selected.map(format));
  return (
    <Dropdown label={label} value={value} className={className}>
      <div className="dropdown-menu" role="group" aria-label={label}>
        <SelectionActions selection={selection} noun={noun} />
        {searchable && (
          <input
            className="ss-search"
            aria-label={`Filter ${label}`}
            placeholder="Type to filter…"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onClick={event => event.stopPropagation()}
            onKeyDown={event => event.stopPropagation()}
          />
        )}
        {shown.map(value => {
          const extra = describe?.(value);
          return (
            <label key={value}>
              <input
                type="checkbox"
                aria-label={format(value)}
                checked={selection.has(value)}
                onChange={() => selection.toggle(value)}
              />
              <span>
                {format(value)}
                {extra ? <small>{extra}</small> : null}
              </span>
            </label>
          );
        })}
        {!shown.length && <p className="ss-empty">No matches</p>}
      </div>
    </Dropdown>
  );
}
