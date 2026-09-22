"use client";

import { useSyncExternalStore } from "react";

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
  }
  for (const notify of listeners) notify();
}

export function usePersisted(key: string, fallback: string): string {
  return useSyncExternalStore(
    subscribe,
    () => readStored(key, fallback),
    () => fallback,
  );
}

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

export function parseLevels(raw: string): number[] {
  const found = new Set<number>();
  for (const part of raw.split(",")) {

    const value = Math.abs(Number(part.trim()));
    if (Number.isFinite(value) && value > 0 && value < 100) {

      found.add(Math.round(value * 10) / 10);
    }
  }
  return [...found].sort((a, b) => a - b);
}
