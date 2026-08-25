import { describe, expect, it } from "vitest";

import type { AgentSessionMetrics, OutcomeKind, ToolOutcome } from "./session-metrics.js";
import { aggregateSessionsByRepo } from "./session-aggregate.js";

function outcome(label: string, kind: OutcomeKind): ToolOutcome {
  return {
    callLine: 1,
    confidence: kind === "tool_error" ? "high" : "low",
    exitCode: kind === "tool_error" ? undefined : 1,
    kind,
    label,
    reason: "fixture",
    resultLine: 2,
    tool: label,
  };
}

function session(id: string, outcomes: readonly ToolOutcome[]): AgentSessionMetrics {
  return {
    compactions: 0,
    cwd: "/repo",
    endedAt: undefined,
    git: { branch: undefined, commitHash: undefined, repositoryUrl: undefined },
    initialPromptChars: 0,
    initialPromptLines: [],
    largestToolOutputChars: 0,
    outcomes,
    sessionId: id,
    source: "codex",
    startedAt: undefined,
    tokens: undefined,
    toolOutputChars: 0,
    toolTimeMs: 0,
    tools: { shell: { calls: outcomes.length, durationMs: 0, failures: outcomes.length } },
    transcriptPath: `/sessions/${id}.jsonl`,
    truncated: false,
    turns: 1,
    userMessages: 1,
    wallClockMs: 1,
  };
}

describe("outcome group selection", () => {
  it("maximizes represented outcomes while reserving evidence for an operational error", () => {
    const outcomes = [
      ...Array.from({ length: 6 }, () => outcome("unknown-a", "unknown_nonzero")),
      ...Array.from({ length: 5 }, () => outcome("unknown-b", "unknown_nonzero")),
      ...Array.from({ length: 4 }, () => outcome("unknown-c", "unknown_nonzero")),
      ...Array.from({ length: 3 }, () => outcome("unknown-d", "unknown_nonzero")),
      ...Array.from({ length: 2 }, () => outcome("unknown-e", "unknown_nonzero")),
      outcome("mcp:linear.get_issue", "tool_error"),
    ];

    const repo = aggregateSessionsByRepo(
      [session("s1", outcomes)],
      new Map([["/repo", "repo"]]),
    )[0];

    expect(repo?.outcomeGroupCount).toBe(6);
    expect(repo?.outcomeCounts.map((group) => group.label)).toEqual([
      "unknown-a",
      "unknown-b",
      "unknown-c",
      "unknown-d",
      "mcp:linear.get_issue",
    ]);
  });
});
