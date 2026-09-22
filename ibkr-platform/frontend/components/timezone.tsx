"use client";

import { useSyncExternalStore } from "react";
import { SearchableSelect } from "./searchable-select";
import { DEFAULT_ZONE, isZoneId, STORAGE_KEY, ZoneId, ZONES } from "@/lib/timezone";


let listeners: (() => void)[] = [];

function subscribe(notify: () => void) {
  listeners = [...listeners, notify];
  window.addEventListener("storage", notify);
  return () => {
    listeners = listeners.filter(listener => listener !== notify);
    window.removeEventListener("storage", notify);
  };
}

function snapshot(): ZoneId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isZoneId(stored) ? stored : DEFAULT_ZONE;
  } catch {
    return DEFAULT_ZONE;
  }
}

function serverSnapshot(): ZoneId {
  return DEFAULT_ZONE;
}

export function setZone(next: ZoneId) {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
  }
  for (const notify of listeners) notify();
}

export function useZone(): ZoneId {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

export function TimezonePicker() {
  const zone = useZone();
  /* Searchable from the first keystroke rather than only past a threshold: the
     list is short today, but "IST" and "ET" are typed far faster than they are
     found by eye, and the same control grows with the zone list. */
  return (
    <div className="tz-picker">
      <SearchableSelect
        label="Display timezone"
        value={zone}
        options={ZONES.map(z => z.id)}
        onChange={next => setZone(next as ZoneId)}
        searchFrom={1}
      />
    </div>
  );
}
