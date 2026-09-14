"use client";

import { useSyncExternalStore } from "react";
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
