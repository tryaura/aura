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

interface SessionOptions {
  readonly cwd?: string | undefined;
  readonly repositoryUrl?: string | undefined;
  readonly source?: AgentSessionMetrics["source"] | undefined;
}

function session(
  id: string,
  outcomes: readonly ToolOutcome[],
  options: SessionOptions = {},
): AgentSessionMetrics {
  return {
    agentTimeMs: 1,
    abortedTurns: 0,
    commands: [],
    compactions: 0,
    completedTurns: 0,
    context: undefined,
    cwd: options.cwd ?? "/repo",
    edits: undefined,
    endedAt: undefined,
    git: {
      branch: undefined,
      commitHash: undefined,
      repositoryUrl: options.repositoryUrl,
    },
    inferredOutcome: undefined,
    initialPromptChars: 0,
    initialPromptLines: [],
    invalidValues: 0,
    interventions: [],
    largestToolOutputChars: 0,
    malformedLines: 0,
    model: undefined,
    outcomes,
    partial: false,
    pullRequests: [],
    readError: false,
    sessionId: id,
    source: options.source ?? "codex",
    startedAt: undefined,
    tokens: undefined,
    toolOutputChars: 0,
    toolTimeMs: 0,
    tools: { shell: { calls: outcomes.length, durationMs: 0, failures: outcomes.length } },
    transcriptPath: `/sessions/${id}.jsonl`,
    truncated: false,
    turnDetails: [],
    turns: 1,
    turnsTruncated: false,
    userMessages: 1,
    validation: undefined,
    wallClockMs: 1,
    workItems: [],
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
      new Map([["/repo", { key: "path:/repo", label: "repo", qualifiedLabel: "/repo" }]]),
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

  it("aggregates the component identities contained by failed shell batches", () => {
    const first = {
      ...outcome("shell batch", "unknown_nonzero"),
      batchComponents: [
        { command: "pnpm", subcommand: "test" },
        { command: "git", subcommand: "diff" },
      ],
    };
    const second = {
      ...outcome("shell batch", "unknown_nonzero"),
      batchComponents: [
        { command: "pnpm", subcommand: "test" },
        { command: "rg", subcommand: undefined },
      ],
    };

    const repo = aggregateSessionsByRepo(
      [session("s1", [first, second])],
      new Map([["/repo", { key: "path:/repo", label: "repo", qualifiedLabel: "/repo" }]]),
    )[0];

    expect(repo?.outcomeCounts[0]).toMatchObject({
      batchComponentCount: 3,
      batchComponents: [
        { command: "pnpm", count: 2, subcommand: "test" },
        { command: "git", count: 1, subcommand: "diff" },
        { command: "rg", count: 1, subcommand: undefined },
      ],
      count: 2,
      label: "shell batch",
    });
  });

  it("retains every missing executable outside the presentation cap", () => {
    const outcomes = [
      ...["a", "b", "c", "d", "e"].flatMap((label) => [
        outcome(label, "tool_error"),
        outcome(label, "tool_error"),
      ]),
      { ...outcome("missing-bin", "invocation_error"), exitCode: 127 },
    ];

    const repo = aggregateSessionsByRepo(
      [session("s1", outcomes)],
      new Map([["/repo", { key: "path:/repo", label: "repo", qualifiedLabel: "/repo" }]]),
    )[0];

    expect(repo?.outcomeCounts.map((group) => group.label)).not.toContain("missing-bin");
    expect(repo?.invocationErrorCounts).toEqual([{ count: 1, label: "missing-bin" }]);
  });

  it("keeps live same-named remotes separate across session sources", () => {
    const repos = aggregateSessionsByRepo(
      [
        session("codex", [], {
          cwd: "/work/acme/api",
          repositoryUrl: "https://github.com/acme/api.git",
        }),
        session("claude", [], {
          cwd: "/work/other/api",
          source: "claude-code",
        }),
      ],
      new Map([
        [
          "/work/other/api",
          {
            key: "remote:github.com/other/api",
            label: "api",
            qualifiedLabel: "github.com/other/api",
          },
        ],
      ]),
    );

    expect(repos.map((repo) => repo.project)).toEqual([
      "github.com/acme/api",
      "github.com/other/api",
    ]);
  });
});
