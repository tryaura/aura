import { describe, expect, it } from "vitest";

import { percentile } from "./chart.js";

describe("percentile", () => {
  it("returns nearest-rank percentiles without mutating the sample", () => {
    const values = [9, 7, 8, 8, 8];

    expect(percentile(values, 0.5)).toBe(8);
    expect(percentile(values, 0.9)).toBe(9);
    expect(values).toEqual([9, 7, 8, 8, 8]);
  });

  it("returns undefined for an empty sample", () => {
    expect(percentile([], 0.5)).toBeUndefined();
  });
});
