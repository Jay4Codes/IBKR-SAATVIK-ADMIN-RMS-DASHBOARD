"use client";

import { useSyncExternalStore } from "react";

/** A browser-local preference, read through an external store.
 *
 *  Reading one into state from an effect renders twice — once with the default
 *  and once with the stored value — which React's rules flag as a cascading
 *  render and the reader sees as a flicker. An external store gives the right
 *  answer on the first render instead.
 *
 *  Every access is guarded: a private window, cleared site data or a blocked
 *  storage policy all throw rather than returning null, and a preference that
 *  cannot be saved should still work for the session.
 */
let listeners: (() => void)[] = [];

function subscribe(notify: () => void) {
  listeners = [...listeners, notify];
  window.addEventListener("storage", notify);
  return () => {
    listeners = listeners.filter(listener => listener !== notify);
    window.removeEventListener("storage", notify);
  };
}

export function readStored(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Unsaved is still usable; only the next visit loses it. */
  }
  // `storage` fires in other tabs only, so this one has to tell itself.
  for (const notify of listeners) notify();
}

export function usePersisted(key: string, fallback: string): string {
  return useSyncExternalStore(
    subscribe,
    () => readStored(key, fallback),
    () => fallback,
  );
}

/** Absolute price levels, stored the same way but not folded into a ± pair:
 *  a price is one column, and its percentage moves as the underlying does. */
export function parsePrices(raw: string): number[] {
  const found = new Set<number>();
  for (const part of raw.split(",")) {
    const value = Number(part.trim());
    if (Number.isFinite(value) && value > 0) {
      found.add(Math.round(value * 100) / 100);
    }
  }
  return [...found].sort((a, b) => a - b);
}

/** Custom scenario levels, stored as a comma-separated list of magnitudes. */
export function parseLevels(raw: string): number[] {
  const found = new Set<number>();
  for (const part of raw.split(",")) {
    // Magnitudes, and forgiving about sign the same way `signedLevels` is: a
    // stored "-3" means the same pair of columns as "3".
    const value = Math.abs(Number(part.trim()));
    if (Number.isFinite(value) && value > 0 && value < 100) {
      // Rounded to a tenth: a grid column headed "+7.3333%" helps nobody.
      found.add(Math.round(value * 10) / 10);
    }
  }
  return [...found].sort((a, b) => a - b);
}
