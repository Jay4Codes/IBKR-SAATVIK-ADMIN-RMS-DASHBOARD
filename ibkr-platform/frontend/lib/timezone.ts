/** The display timezone for every absolute timestamp on the page.
 *
 *  Only wall-clock values move: "9s ago" and a session length are durations and
 *  read the same everywhere. The risk model's date follows the selection too,
 *  because a trader working in IST means their own calendar day when they read
 *  days-to-expiry off the payoff curve.
 */

export const ZONES = [
  { id: "ET", zone: "America/New_York", title: "US Eastern — the exchange's own clock" },
  { id: "CT", zone: "America/Chicago", title: "US Central" },
  { id: "UTC", zone: "UTC", title: "Coordinated Universal Time" },
  { id: "IST", zone: "Asia/Kolkata", title: "India Standard Time" },
] as const;

export type ZoneId = (typeof ZONES)[number]["id"];

/** The exchange's clock: the default a US options desk reads by. */
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

/** Date and time, e.g. an execution's timestamp. "—" when there is nothing to show. */
export function formatDateTime(iso: string | number | null | undefined, id: ZoneId): string {
  const date = parsed(iso);
  return date ? date.toLocaleString(undefined, { timeZone: zoneOf(id) }) : "—";
}

/** Time only, for values whose date is implied by the row around them. */
export function formatTime(iso: string | number | null | undefined, id: ZoneId): string {
  const date = parsed(iso);
  return date ? date.toLocaleTimeString(undefined, { timeZone: zoneOf(id) }) : "—";
}

/** Seconds-resolution clock for the header, always zero-padded. */
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

/** The calendar date in this zone, as YYYY-MM-DD. */
export function todayIn(id: ZoneId, now: number = Date.now()): string {
  // en-CA renders ISO-ordered dates, which is exactly the shape the risk model
  // compares against an option's expiry.
  return new Date(now).toLocaleDateString("en-CA", { timeZone: zoneOf(id) });
}
