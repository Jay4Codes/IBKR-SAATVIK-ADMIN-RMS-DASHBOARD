/** CBOE index-option trading sessions, and how long until the next boundary.
 *
 *  The desk trades SPX, so the clock that matters is Cboe's index-option
 *  session rather than the equity market's:
 *
 *    Global Trading Hours   20:15 → 09:15 ET, Sunday evening to Friday morning
 *    Regular Trading Hours  09:30 → 16:15 ET, weekdays
 *
 *  Index options run fifteen minutes past the equity close, and the two sessions
 *  do not touch — there is a fifteen-minute gap before the open and just over
 *  four hours after the close. Early-close days end RTH at 13:15.
 *
 *  Holiday and early-close dates are the tables the US-Trading-Infra project
 *  maintains for the same desk, so both systems agree on which days are dark.
 *  They are literal dates and need extending each year.
 */

export const ET_ZONE = "America/New_York";

export const FULL_HOLIDAYS = new Set([
  "2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
  "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
]);

export const EARLY_CLOSE = new Set([
  "2025-07-03", "2025-11-28", "2025-12-24", "2026-11-27", "2026-12-24",
]);

/** Minutes past ET midnight. */
const GTH_OPEN = 20 * 60 + 15;
const GTH_CLOSE = 9 * 60 + 15;
const RTH_OPEN = 9 * 60 + 30;
const RTH_CLOSE = 16 * 60 + 15;
const RTH_CLOSE_EARLY = 13 * 60 + 15;

export type Session = "rth" | "gth" | "closed";

export type MarketState = {
  session: Session;
  /** What to call the session in the header. */
  label: string;
  /** Whether the countdown is to a close (open now) or to an open. */
  openNow: boolean;
  /** Milliseconds until the session ends, or until the next one begins. */
  until: number;
  /** The boundary being counted down to, as an ET wall-clock time. */
  atLabel: string;
};

type EtNow = { date: string; minutes: number; weekday: number };

/** The ET wall clock for an instant: its calendar date, minute of day and weekday. */
export function etNow(at: number): EtNow {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ET_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: hour * 60 + Number(get("minute")) + Number(get("second")) / 60,
    weekday: Math.max(0, days.indexOf(get("weekday"))),
  };
}

/** How far ET is from UTC at this instant, in minutes. */
function etOffset(at: number): number {
  const et = new Date(new Date(at).toLocaleString("en-US", { timeZone: ET_ZONE }));
  const utc = new Date(new Date(at).toLocaleString("en-US", { timeZone: "UTC" }));
  return Math.round((et.getTime() - utc.getTime()) / 60000);
}

/** The instant of an ET wall-clock time, `addDays` after the ET date of `at`. */
function instantAt(at: number, minutes: number, addDays = 0): number {
  const { date } = etNow(at);
  const [year, month, day] = date.split("-").map(Number);
  const midnightUtc = Date.UTC(year, month - 1, day + addDays);
  return midnightUtc + minutes * 60000 - etOffset(at) * 60000;
}

const isTradingDay = (date: string, weekday: number) =>
  weekday >= 1 && weekday <= 5 && !FULL_HOLIDAYS.has(date);

function rthClose(date: string) {
  return EARLY_CLOSE.has(date) ? RTH_CLOSE_EARLY : RTH_CLOSE;
}

function clock(minutes: number): string {
  const total = Math.round(minutes);
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** Days ahead (1-7) of the next day that trades RTH. */
function nextTradingDay(at: number): number {
  for (let ahead = 1; ahead <= 8; ahead += 1) {
    const probe = etNow(at + ahead * 86400000);
    if (isTradingDay(probe.date, probe.weekday)) return ahead;
  }
  return 1;
}

/** Which session is running, and how long until that changes. */
export function marketState(at: number = Date.now()): MarketState {
  const { date, minutes, weekday } = etNow(at);
  const trading = isTradingDay(date, weekday);
  const close = rthClose(date);

  if (trading && minutes >= RTH_OPEN && minutes < close) {
    return {
      session: "rth",
      label: "Regular",
      openNow: true,
      until: instantAt(at, close) - at,
      atLabel: clock(close),
    };
  }

  // GTH runs overnight, so before 09:15 it belongs to the session that opened
  // the evening before — which only counts if that evening actually traded.
  const yesterday = etNow(at - 86400000);
  if (minutes < GTH_CLOSE && isTradingDay(yesterday.date, yesterday.weekday) && trading) {
    return {
      session: "gth",
      label: "Global",
      openNow: true,
      until: instantAt(at, GTH_CLOSE) - at,
      atLabel: clock(GTH_CLOSE),
    };
  }
  if (minutes >= GTH_OPEN && trading) {
    // The evening session belongs to the next day's trading.
    const ahead = nextTradingDay(at);
    return {
      session: "gth",
      label: "Global",
      openNow: true,
      until: instantAt(at, GTH_CLOSE, ahead) - at,
      atLabel: clock(GTH_CLOSE),
    };
  }

  // Closed: count down to whichever opens next.
  if (trading && minutes < RTH_OPEN) {
    return {
      session: "closed",
      label: "Pre-open",
      openNow: false,
      until: instantAt(at, RTH_OPEN) - at,
      atLabel: clock(RTH_OPEN),
    };
  }
  if (trading && minutes < GTH_OPEN) {
    return {
      session: "closed",
      label: "Closed",
      openNow: false,
      until: instantAt(at, GTH_OPEN) - at,
      atLabel: clock(GTH_OPEN),
    };
  }
  const ahead = nextTradingDay(at);
  // The evening before the next trading day opens GTH, unless today already
  // passed its own evening open without trading (a weekend or holiday).
  const eveningBefore = instantAt(at, GTH_OPEN, ahead - 1);
  const target = eveningBefore > at ? eveningBefore : instantAt(at, RTH_OPEN, ahead);
  return {
    session: "closed",
    label: FULL_HOLIDAYS.has(date) ? "Holiday" : "Closed",
    openNow: false,
    until: target - at,
    atLabel: clock(eveningBefore > at ? GTH_OPEN : RTH_OPEN),
  };
}

/** A countdown a trader can read at a glance: 4h 12m, 12m 30s, 45s. */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** True once a close is near enough to matter to someone holding risk. */
export const CLOSING_SOON = 30 * 60 * 1000;
