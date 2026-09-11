import { describe, expect, it } from "vitest";
import { countdown, marketState } from "@/lib/market";

// September 2026 is EDT (UTC-4), so 13:30Z = 09:30 ET.
const et = (iso: string) => Date.parse(iso);

describe("CBOE index-option sessions", () => {
  it("is in regular hours between the open and the index close", () => {
    const state = marketState(et("2026-09-10T14:00:00Z")); // 10:00 ET, Thursday
    expect(state).toMatchObject({ session: "rth", label: "Regular", openNow: true, atLabel: "16:15" });
    expect(countdown(state.until)).toBe("6h 15m");
  });

  it("counts down to the index close, fifteen minutes past the equity close", () => {
    const state = marketState(et("2026-09-10T20:10:00Z")); // 16:10 ET
    expect(state.session).toBe("rth");
    expect(countdown(state.until)).toBe("5m 00s");
  });

  it("treats the evening as global hours running into the next morning", () => {
    const state = marketState(et("2026-09-10T22:00:00Z")); // 18:00 ET — after RTH, before GTH
    expect(state).toMatchObject({ session: "closed", label: "Closed", openNow: false, atLabel: "20:15" });
    const evening = marketState(et("2026-09-11T01:00:00Z")); // 21:00 ET Thursday
    expect(evening).toMatchObject({ session: "gth", label: "Global", openNow: true, atLabel: "09:15" });
  });

  it("stays in global hours through the small hours until 09:15", () => {
    const state = marketState(et("2026-09-10T11:00:00Z")); // 07:00 ET Thursday
    expect(state.session).toBe("gth");
    expect(countdown(state.until)).toBe("2h 15m");
  });

  it("closes for the gap between the global close and the regular open", () => {
    const state = marketState(et("2026-09-10T13:20:00Z")); // 09:20 ET
    expect(state).toMatchObject({ session: "closed", label: "Pre-open", openNow: false, atLabel: "09:30" });
    expect(countdown(state.until)).toBe("10m 00s");
  });

  it("ends an early-close day at 13:15", () => {
    const state = marketState(et("2026-11-27T17:00:00Z")); // 12:00 ET, day after Thanksgiving (EST)
    expect(state.session).toBe("rth");
    expect(state.atLabel).toBe("13:15");
    expect(countdown(state.until)).toBe("1h 15m");
  });

  it("says holiday and points at the next session", () => {
    const state = marketState(et("2026-12-25T16:00:00Z")); // Christmas, a Friday
    expect(state).toMatchObject({ session: "closed", label: "Holiday", openNow: false });
    expect(state.until).toBeGreaterThan(0);
  });

  it("does not open on a weekend", () => {
    for (const stamp of ["2026-09-12T14:00:00Z", "2026-09-13T14:00:00Z"]) {
      expect(marketState(et(stamp)).openNow).toBe(false);
    }
  });

  it("counts a weekend down in days rather than a four-figure hour count", () => {
    const state = marketState(et("2026-09-12T14:00:00Z")); // Saturday
    expect(countdown(state.until)).toMatch(/^\d+d \d+h$/);
  });

  it("reads a countdown at the precision that matters", () => {
    expect(countdown(6 * 3600_000 + 15 * 60_000)).toBe("6h 15m");
    expect(countdown(90_000)).toBe("1m 30s");
    expect(countdown(45_000)).toBe("45s");
    expect(countdown(-5)).toBe("0s");
  });
});
