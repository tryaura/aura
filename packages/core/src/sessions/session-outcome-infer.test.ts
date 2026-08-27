import { describe, expect, it } from "vitest";

import { inferSessionOutcome } from "./session-outcome-infer.js";
import type { SessionTurn } from "./session-detail-metrics.js";

function turn(closed: SessionTurn["closed"]): SessionTurn {
  return {
    closed,
    durationMs: 1000,
    endedAt: undefined,
    index: 0,
    model: undefined,
    startedAt: undefined,
    timeToFirstTokenMs: undefined,
    tokens: undefined,
    toolCalls: 0,
    toolTimeMs: 0,
    turnId: undefined,
  };
}

describe("inferSessionOutcome", () => {
  it("reads a completed final turn as completion, split by interventions", () => {
    expect(inferSessionOutcome([turn("completed")], 0, 0)).toEqual({
      confidence: "medium",
      status: "completed_autonomously",
    });
    expect(inferSessionOutcome([turn("completed")], 2, 0)).toEqual({
      confidence: "medium",
      status: "completed_with_help",
    });
  });

  it("raises confidence when a pull request was left behind", () => {
    expect(inferSessionOutcome([turn("completed")], 0, 1)).toEqual({
      confidence: "high",
      status: "completed_autonomously",
    });
  });

  it("reads aborted and cut-off endings as abandonment at matching confidence", () => {
    expect(inferSessionOutcome([turn("aborted")], 1, 0)).toEqual({
      confidence: "medium",
      status: "abandoned",
    });
    expect(
      inferSessionOutcome([turn("completed"), { ...turn("log-end"), index: 1 }], 0, 0),
    ).toEqual({ confidence: "low", status: "abandoned" });
  });

  it("stays silent when the transcript recorded no turns", () => {
    expect(inferSessionOutcome([], 0, 0)).toBeUndefined();
  });
});
