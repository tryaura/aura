import { describe, expect, it } from "vitest";

import { utcDayKey, utcTimestampMs } from "./iso-time.js";

describe("utc time helpers", () => {
  it("round-trips timestamps through epoch milliseconds and day keys", () => {
    const ms = utcTimestampMs("2026-08-20T10:30:15.250Z");

    expect(ms).toBe(Date.UTC(2026, 7, 20, 10, 30, 15, 250));
    expect(ms === undefined ? undefined : utcDayKey(ms)).toBe("2026-08-20");
    expect(utcDayKey(0)).toBe("1970-01-01");
    expect(utcDayKey(Date.UTC(2024, 1, 29, 23, 59, 59))).toBe("2024-02-29");
  });

  it("rejects non-UTC and malformed timestamps", () => {
    expect(utcTimestampMs("2026-08-20T10:30:15+02:00")).toBeUndefined();
    expect(utcTimestampMs("2026-13-01T00:00:00Z")).toBeUndefined();
    expect(utcTimestampMs("2026-02-31T10:30:15Z")).toBeUndefined();
    expect(utcTimestampMs("2026-08-20T24:00:00Z")).toBeUndefined();
    expect(utcTimestampMs("2026-08-20T10:60:00Z")).toBeUndefined();
    expect(utcTimestampMs("not a time")).toBeUndefined();
  });
});
