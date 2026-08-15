import { describe, expect, it } from "vitest";

import { evaluateSupport, isComparableRange } from "./support.js";

describe("evaluateSupport", () => {
  it("reports a version inside the declared range as supported", () => {
    expect(evaluateSupport(">=1 <2", "1.4.2")).toEqual({
      status: "supported",
      supportedRange: ">=1 <2",
      version: "1.4.2",
    });
  });

  it("reports a version outside the declared range as unsupported", () => {
    expect(evaluateSupport(">=1 <2", "2.0.0")).toEqual({
      status: "unsupported",
      supportedRange: ">=1 <2",
      version: "2.0.0",
    });
  });

  it("coerces a loosely reported version but keeps the raw one for reporting", () => {
    expect(evaluateSupport(">=1 <2", "v1.2 (build 41)")).toEqual({
      status: "supported",
      supportedRange: ">=1 <2",
      version: "v1.2 (build 41)",
    });
  });

  it("is unknown when detection found no version", () => {
    expect(evaluateSupport(">=1 <2", undefined)).toEqual({
      status: "unknown",
      supportedRange: ">=1 <2",
      version: undefined,
    });
  });

  it("is unknown when the version cannot be parsed at all", () => {
    expect(evaluateSupport(">=1 <2", "nightly")).toMatchObject({ status: "unknown" });
  });

  it("is unknown when the adapter declares a range that does not parse", () => {
    expect(evaluateSupport("not a range", "1.0.0")).toMatchObject({
      status: "unknown",
      supportedRange: "not a range",
    });
  });
});

describe("isComparableRange", () => {
  it("accepts a semver range and rejects anything else", () => {
    expect(isComparableRange(">=1 <2")).toBe(true);
    expect(isComparableRange("not a range")).toBe(false);
  });
});
