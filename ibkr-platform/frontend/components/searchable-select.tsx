"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

export function SearchableSelect({
  label,
  value,
  options,
  onChange,
  searchFrom = 7,
  format = option => option,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  searchFrom?: number;
  format?: (value: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();

  const searchable = options.length >= searchFrom;
  const shown = searchable
    ? options.filter(option => {
        const needle = query.toLowerCase();
        return option.toLowerCase().includes(needle) || format(option).toLowerCase().includes(needle);
      })
    : options;

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const choose = (option: string) => {
    onChange(option);
    setOpen(false);
    setQuery("");
    setActive(0);
  };

  const keys = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive(current => (current + step + shown.length) % Math.max(1, shown.length));
      return;
    }
    if (event.key === "Enter" && open && shown[active]) {
      event.preventDefault();
      choose(shown[active]);
    }
  };

  return (
    <div className="ss" ref={box} onKeyDown={keys}>
      <button
        type="button"
        className="ss-value"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => {
          setOpen(!open);
          setQuery("");
          setActive(Math.max(0, options.indexOf(value)));
        }}
      >
        <span>{format(value) || value || "—"}</span>
        <ChevronDown size={16} strokeWidth={2.25} aria-hidden="true" className="ss-caret" />
      </button>
      {open && (
        <div className="ss-pop">
          {searchable && (
            <input
              autoFocus
              className="ss-search"
              aria-label={`Filter ${label}`}
              placeholder="Type to filter…"
              value={query}
              onChange={event => {
                setQuery(event.target.value);
                setActive(0);
              }}
            />
          )}
          <ul id={listId} role="listbox" aria-label={label} className="ss-list">
            {shown.map((option, index) => (
              <li key={option}>
                <button
                  type="button"
                  role="option"
                  aria-selected={option === value}
                  className={`${option === value ? "selected" : ""} ${index === active ? "active" : ""}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(option)}
                >
                  {format(option)}
                </button>
              </li>
            ))}
            {!shown.length && <li className="ss-empty">No matches</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
