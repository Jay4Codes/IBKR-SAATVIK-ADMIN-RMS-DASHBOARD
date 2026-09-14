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

const GTH_OPEN = 20 * 60 + 15;
const GTH_CLOSE = 9 * 60 + 15;
const RTH_OPEN = 9 * 60 + 30;
const RTH_CLOSE = 16 * 60 + 15;
const RTH_CLOSE_EARLY = 13 * 60 + 15;

export type Session = "rth" | "gth" | "closed";

export type MarketState = {
  session: Session;
  label: string;
  openNow: boolean;
  until: number;
  atLabel: string;
};

type EtNow = { date: string; minutes: number; weekday: number };

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

function etOffset(at: number): number {
  const et = new Date(new Date(at).toLocaleString("en-US", { timeZone: ET_ZONE }));
  const utc = new Date(new Date(at).toLocaleString("en-US", { timeZone: "UTC" }));
  return Math.round((et.getTime() - utc.getTime()) / 60000);
}

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

function nextTradingDay(at: number): number {
  for (let ahead = 1; ahead <= 8; ahead += 1) {
    const probe = etNow(at + ahead * 86400000);
    if (isTradingDay(probe.date, probe.weekday)) return ahead;
  }
  return 1;
}

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
    const ahead = nextTradingDay(at);
    return {
      session: "gth",
      label: "Global",
      openNow: true,
      until: instantAt(at, GTH_CLOSE, ahead) - at,
      atLabel: clock(GTH_CLOSE),
    };
  }

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

export const CLOSING_SOON = 30 * 60 * 1000;
