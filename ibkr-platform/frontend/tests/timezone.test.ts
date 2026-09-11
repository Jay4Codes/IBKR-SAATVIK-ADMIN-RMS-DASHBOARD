import { describe, expect, it } from "vitest";
import { DEFAULT_ZONE, formatClock, formatDateTime, formatTime, isZoneId, todayIn, ZONES, zoneOf } from "@/lib/timezone";

// 2026-09-09T23:30:00Z — chosen so the calendar date differs by zone: still the
// 9th in the Americas, already the 10th in UTC and India.
const LATE = "2026-09-09T23:30:00Z";

describe("display timezone", () => {
  it("offers exactly the four desks trade from", () => {
    expect(ZONES.map(z => z.id)).toEqual(["ET", "CT", "UTC", "IST"]);
    expect(DEFAULT_ZONE).toBe("ET");
    expect(zoneOf("IST")).toBe("Asia/Kolkata");
  });
  it("renders the same instant at each desk's own wall clock", () => {
    expect(formatClock(Date.parse(LATE), "UTC")).toBe("23:30:00");
    expect(formatClock(Date.parse(LATE), "ET")).toBe("19:30:00");
    expect(formatClock(Date.parse(LATE), "CT")).toBe("18:30:00");
    expect(formatClock(Date.parse(LATE), "IST")).toBe("05:00:00");
  });
  it("moves the calendar day across the dateline, which the risk model reads", () => {
    expect(todayIn("ET", Date.parse(LATE))).toBe("2026-09-09");
    expect(todayIn("UTC", Date.parse(LATE))).toBe("2026-09-09");
    expect(todayIn("IST", Date.parse(LATE))).toBe("2026-09-10");
  });
  it("shows a dash rather than Invalid Date for a missing or broken stamp", () => {
    for (const bad of [undefined, null, "", "not a date"]) {
      expect(formatDateTime(bad, "ET")).toBe("—");
      expect(formatTime(bad, "ET")).toBe("—");
    }
    expect(formatClock(Number.NaN, "ET")).toBe("--:--:--");
  });
  it("recognises only the four ids, so stored junk cannot select a zone", () => {
    expect(isZoneId("IST")).toBe(true);
    expect(isZoneId("ist")).toBe(false);
    expect(isZoneId("America/New_York")).toBe(false);
    expect(isZoneId(null)).toBe(false);
  });
});
