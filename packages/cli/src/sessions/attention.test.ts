import { describe, expect, it } from "vitest";

import type { OutcomeCount, RepoSessionAggregate, SessionAnalysis } from "@tryaura/core";

import { attentionFindings } from "./attention.js";

const HOME = "/home/user";

function outcome(
  kind: OutcomeCount["kind"],
  label: string,
  countValue: number,
  exitCode?: number,
): OutcomeCount {
  return {
    confidence: kind === "unknown_nonzero" ? "low" : "high",
    count: countValue,
    exemplars: [],
    exitCode,
    kind,
    label,
    reason: "fixture",
  };
}

function repo(overrides: Partial<RepoSessionAggregate>): RepoSessionAggregate {
  return {
    agentTimeMs: 0,
    abortedTurns: 0,
    checkFailures: 0,
    compactionProfile: {
      compactedInitialPromptCharsAverage: 0,
      compactedSessions: 0,
      compactedToolOutputCharsAverage: 0,
      compactedTurnsAverage: 0,
      cleanInitialPromptCharsAverage: 0,
      cleanSessions: 1,
      cleanToolOutputCharsAverage: 0,
      cleanTurnsAverage: 1,
    },
    compactions: 0,
    directories: 1,
    expectedStatuses: 0,
    failedToolCalls: 0,
    hotspots: [],
    interventions: 0,
    invalidValues: 0,
    invocationErrorCounts: [],
    invocationErrors: 0,
    malformedLines: 0,
    neverGreenSessions: 0,
    operationalFailures: 0,
    outcomeCounts: [],
    outcomeGroupCount: 0,
    partialSessions: 0,
    project: `${HOME}/project`,
    readErrorSessions: 0,
    sessions: 4,
    tokens: { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0 },
    toolCalls: 100,
    toolTimeMs: 0,
    truncatedSessions: 0,
    turns: 1,
    unknownOutcomes: 0,
    validationTimeMs: 0,
    wallClockMs: 0,
    ...overrides,
  };
}

function analysis(repos: readonly RepoSessionAggregate[]): SessionAnalysis {
  return {
    invalidValues: 0,
    malformedLines: 0,
    partialFiles: 0,
    readErrorFiles: 0,
    repos,
    scannedFiles: repos.length,
    sessions: [],
    since: "2026-08-01",
    sources: ["codex"],
    unreadableFiles: 0,
    workItems: [],
  };
}

describe("attention findings", () => {
  it("stays quiet for ordinary unknown-nonzero volume and incomplete transcripts", () => {
    const fleet = analysis([
      repo({ project: `${HOME}/a`, toolCalls: 1000, unknownOutcomes: 30 }),
      repo({ project: `${HOME}/b`, partialSessions: 1, toolCalls: 800, unknownOutcomes: 20 }),
    ]);

    expect(attentionFindings(fleet, HOME)).toEqual([]);
  });

  it("flags a failure-rate outlier against the fleet, naming its worst signature", () => {
    const fleet = analysis([
      repo({
        outcomeCounts: [outcome("unknown_nonzero", "computer", 12)],
        project: `${HOME}/noisy`,
        toolCalls: 223,
        unknownOutcomes: 36,
      }),
      repo({ project: `${HOME}/busy`, toolCalls: 10_000, unknownOutcomes: 100 }),
    ]);

    expect(attentionFindings(fleet, HOME)).toEqual([
      "~/noisy — 16% of 223 tool calls failed · fleet rate 1% · worst: computer ×12",
    ]);
  });

  it("describes common components without naming a failing segment for a shell batch", () => {
    const batch = {
      ...outcome("unknown_nonzero", "shell batch", 301),
      batchComponentCount: 4,
      batchComponents: [
        { command: "pnpm", count: 184, subcommand: "test" },
        { command: "git", count: 72, subcommand: "diff" },
        { command: "rg", count: 45, subcommand: undefined },
      ],
    };
    const fleet = analysis([
      repo({
        outcomeCounts: [batch],
        project: `${HOME}/family_planner`,
        toolCalls: 10_000,
        unknownOutcomes: 600,
      }),
      repo({ project: `${HOME}/busy`, toolCalls: 10_000, unknownOutcomes: 200 }),
    ]);

    expect(attentionFindings(fleet, HOME)).toEqual([
      "~/family_planner — 6% of 10,000 tool calls failed · fleet rate 2% · worst: shell batch ×301 · contains: pnpm test ×184, git diff ×72, rg ×45, +1 more",
    ]);
  });

  it("flags confirmed environment failures without waiting for volume", () => {
    const fleet = analysis([
      repo({
        operationalFailures: 3,
        outcomeCounts: [outcome("tool_error", "mcp-browser", 3)],
        project: `${HOME}/mcp`,
        toolCalls: 10,
        unknownOutcomes: 0,
      }),
    ]);

    expect(attentionFindings(fleet, HOME)).toEqual([
      "~/mcp — 30% of 10 tool calls failed · worst: mcp-browser ×3",
    ]);
  });

  it("groups missing executables across projects into one remediation line", () => {
    const missing = (project: string): RepoSessionAggregate =>
      repo({
        invocationErrorCounts: [{ count: 2, label: "pnpm" }],
        invocationErrors: 2,
        operationalFailures: 2,
        outcomeCounts: [],
        project,
      });
    const fleet = analysis([missing(`${HOME}/a`), missing(`${HOME}/b`)]);

    expect(attentionFindings(fleet, HOME)).toEqual([
      "pnpm not found (exit 127) — 4 failing calls across 2 projects · install it or fix the instructions that call it",
    ]);
  });

  it("flags never-green sessions from two occurrences and compaction pressure", () => {
    const fleet = analysis([
      repo({ neverGreenSessions: 2, project: `${HOME}/red` }),
      repo({ neverGreenSessions: 1, project: `${HOME}/iterating` }),
      repo({ compactions: 3, project: `${HOME}/long`, sessions: 4 }),
    ]);

    expect(attentionFindings(fleet, HOME)).toEqual([
      "~/red — 2 sessions ran validation and never saw it pass",
      "~/long — 3 compactions across 4 sessions · work repeatedly outgrew the context window",
    ]);
  });
});
