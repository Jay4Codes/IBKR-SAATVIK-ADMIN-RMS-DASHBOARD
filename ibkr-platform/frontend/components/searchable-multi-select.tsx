"use client";

import { useState } from "react";
import { Dropdown } from "./dropdown";
import { Selection, SelectionActions } from "./selection";

export function SearchableMultiSelect({
  label,
  selection,
  noun,
  searchFrom = 7,
  describe,
}: {
  label: string;
  selection: Selection;
  noun: string;
  searchFrom?: number;
  describe?: (value: string) => string;
}) {
  const [query, setQuery] = useState("");
  const searchable = selection.options.length >= searchFrom;
  const needle = query.trim().toLowerCase();
  const shown = !searchable || !needle
    ? selection.options
    : selection.options.filter(option => {
        const extra = describe?.(option) ?? "";
        return option.toLowerCase().includes(needle) || extra.toLowerCase().includes(needle);
      });

  return (
    <Dropdown label={label} value={selection.summary}>
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
                aria-label={value}
                checked={selection.has(value)}
                onChange={() => selection.toggle(value)}
              />
              <span>
                {value}
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
