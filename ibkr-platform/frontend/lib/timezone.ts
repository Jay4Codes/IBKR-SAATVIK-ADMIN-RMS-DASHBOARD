export const ZONES = [
  { id: "ET", zone: "America/New_York", title: "US Eastern — the exchange's own clock" },
  { id: "CT", zone: "America/Chicago", title: "US Central" },
  { id: "UTC", zone: "UTC", title: "Coordinated Universal Time" },
  { id: "IST", zone: "Asia/Kolkata", title: "India Standard Time" },
] as const;

export type ZoneId = (typeof ZONES)[number]["id"];

export const DEFAULT_ZONE: ZoneId = "ET";

export const STORAGE_KEY = "rms.timezone";

export function zoneOf(id: ZoneId): string {
  return ZONES.find(z => z.id === id)?.zone ?? "UTC";
}

export function isZoneId(value: unknown): value is ZoneId {
  return ZONES.some(z => z.id === value);
}

function parsed(iso: string | number | null | undefined): Date | null {
  if (iso === null || iso === undefined || iso === "") return null;
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export function formatDateTime(iso: string | number | null | undefined, id: ZoneId): string {
  const date = parsed(iso);
  return date ? date.toLocaleString(undefined, { timeZone: zoneOf(id) }) : "—";
}

export function formatTime(iso: string | number | null | undefined, id: ZoneId): string {
  const date = parsed(iso);
  return date ? date.toLocaleTimeString(undefined, { timeZone: zoneOf(id) }) : "—";
}

export function formatClock(ms: number, id: ZoneId): string {
  const date = parsed(ms);
  if (!date) return "--:--:--";
  return date.toLocaleTimeString("en-GB", {
    timeZone: zoneOf(id),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function todayIn(id: ZoneId, now: number = Date.now()): string {
  return new Date(now).toLocaleDateString("en-CA", { timeZone: zoneOf(id) });
}
