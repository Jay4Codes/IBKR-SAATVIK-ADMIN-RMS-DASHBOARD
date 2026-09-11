"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_ZONE, isZoneId, STORAGE_KEY, ZoneId, ZONES } from "@/lib/timezone";

/* The choice lives in localStorage, which is an external store rather than
   React state: reading it in an effect would mean a render at the default zone
   followed by a second at the stored one. `useSyncExternalStore` gets the
   server and first client render right, and the `storage` event keeps a second
   tab in step for free. */

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
    // A browser refusing storage still gets a working page, at the default.
    return DEFAULT_ZONE;
  }
}

/** No storage on the server, so it renders the default and reconciles on mount. */
function serverSnapshot(): ZoneId {
  return DEFAULT_ZONE;
}

export function setZone(next: ZoneId) {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // The choice simply will not survive a reload.
  }
  // `storage` only fires in *other* tabs; this one has to be told.
  for (const notify of listeners) notify();
}

/** The zone every timestamp on the page is rendered in. */
export function useZone(): ZoneId {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

export function TimezonePicker() {
  const zone = useZone();
  return (
    <label className="tz-picker">
      <span className="sr-only">Display timezone</span>
      <select
        aria-label="Display timezone"
        value={zone}
        onChange={event => setZone(event.target.value as ZoneId)}
      >
        {ZONES.map(z => (
          <option key={z.id} value={z.id} title={z.title}>
            {z.id}
          </option>
        ))}
      </select>
    </label>
  );
}
