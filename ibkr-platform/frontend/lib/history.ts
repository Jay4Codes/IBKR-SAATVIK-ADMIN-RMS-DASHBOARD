/** The first trading day the desk's records on this platform are complete. Nothing is charted before it. */
export const HISTORY_START = "2026-09-22";

export type Period = "day" | "week" | "month" | "quarter" | "all";

export const PERIODS: { id: Period; label: string; days: number }[] = [
  { id: "day", label: "Day", days: 1 },
  { id: "week", label: "Week", days: 7 },
  { id: "month", label: "Month", days: 30 },
  { id: "quarter", label: "Quarter", days: 91 },
  { id: "all", label: "All", days: 0 },
];

/** ISO date `days` ago, never earlier than HISTORY_START; 0 means the whole record. */
export function sinceDays(days: number, now: number = Date.now()): string {
  if (!days) return HISTORY_START;
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - days);
  const iso = from.toISOString().slice(0, 10);
  return iso < HISTORY_START ? HISTORY_START : iso;
}
