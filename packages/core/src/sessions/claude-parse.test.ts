import { describe, expect, it } from "vitest";

import { parseClaudeSession } from "./claude-parse.js";

function record(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    cwd: "/repo/app",
    gitBranch: "main",
    isSidechain: false,
    parentUuid: null,
    sessionId: "session-1",
    timestamp: "2026-08-20T10:00:00.000Z",
    type: "user",
    uuid: "uuid-0",
    ...overrides,
  });
}

function prompt(timestamp: string, text: string, overrides: Record<string, unknown> = {}): string {
  return record({
    message: { content: text, role: "user" },
    promptSource: "typed",
    timestamp,
    ...overrides,
  });
}

function assistant(timestamp: string, message: Record<string, unknown>): string {
  return record({
    message: {
      id: "msg-1",
      model: "claude-opus-5",
      role: "assistant",
      stop_reason: null,
      ...message,
    },
    timestamp,
    type: "assistant",
  });
}

function toolResult(
  timestamp: string,
  toolUseId: string,
  content: unknown,
  isError = false,
): string {
  return record({
    message: {
      content: [{ content, is_error: isError, tool_use_id: toolUseId, type: "tool_result" }],
      role: "user",
    },
    timestamp,
  });
}

describe("parseClaudeSession", () => {
  it("extracts identity, turns, tokens, tools, and wall clock from a transcript", () => {
    const content = [
      JSON.stringify({ aiTitle: "Fix tests", sessionId: "session-1", type: "ai-title" }),
      prompt("2026-08-20T10:00:00.000Z", "Fix AURA-123 please"),
      assistant("2026-08-20T10:00:05.000Z", {
        content: [{ text: "ok", type: "text" }],
        usage: {
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 100,
          input_tokens: 2,
          output_tokens: 10,
        },
      }),
      assistant("2026-08-20T10:00:06.000Z", {
        content: [
          { id: "toolu-1", input: { command: "pnpm test" }, name: "Bash", type: "tool_use" },
        ],
        stop_reason: "tool_use",
        usage: {
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 100,
          input_tokens: 2,
          output_tokens: 10,
        },
      }),
      toolResult("2026-08-20T10:00:16.000Z", "toolu-1", "1 passed"),
      assistant("2026-08-20T10:00:20.000Z", {
        content: [{ text: "done", type: "text" }],
        id: "msg-2",
        stop_reason: "end_turn",
        usage: {
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 200,
          input_tokens: 1,
          output_tokens: 20,
        },
      }),
    ].join("\n");

    const session = parseClaudeSession(content, false);

    expect(session).toEqual({
      agentTimeMs: 20_000,
      abortedTurns: 0,
      commands: [
        {
          calls: 1,
          command: "pnpm",
          durationMs: 10_000,
          failures: 0,
          subcommand: "test",
          tool: "shell",
          validation: true,
        },
      ],
      compactions: 0,
      completedTurns: 1,
      context: {
        initialContextTokens: 152,
        modelContextWindow: undefined,
        peakRequestTokens: 221,
      },
      cwd: "/repo/app",
      edits: undefined,
      endedAt: "2026-08-20T10:00:20.000Z",
      git: { branch: "main", commitHash: undefined, repositoryUrl: undefined },
      inferredOutcome: { confidence: "medium", status: "completed_autonomously" },
      initialPromptChars: 19,
      initialPromptLines: [2],
      invalidValues: 0,
      interventions: [],
      largestToolOutputChars: 8,
      malformedLines: 0,
      model: "claude-opus-5",
      outcomes: [],
      partial: false,
      pullRequests: [],
      readError: false,
      sessionId: "session-1",
      source: "claude-code",
      startedAt: "2026-08-20T10:00:00.000Z",
      tokens: { cachedInputTokens: 300, inputTokens: 353, outputTokens: 30 },
      toolOutputChars: 8,
      toolTimeMs: 10_000,
      tools: { shell: { calls: 1, durationMs: 10_000, failures: 0 } },
      truncated: false,
      turnDetails: [
        {
          closed: "completed",
          durationMs: 20_000,
          endedAt: "2026-08-20T10:00:20.000Z",
          index: 0,
          model: "claude-opus-5",
          startedAt: "2026-08-20T10:00:00.000Z",
          timeToFirstTokenMs: undefined,
          tokens: { cachedInputTokens: 300, inputTokens: 353, outputTokens: 30 },
          toolCalls: 1,
          toolTimeMs: 10_000,
          turnId: undefined,
        },
      ],
      turns: 1,
      turnsTruncated: false,
      userMessages: 1,
      validation: {
        attempts: 1,
        failures: 0,
        iterationsToFirstGreen: 1,
        timeMs: 10_000,
        tokensAtFirstGreen: { cachedInputTokens: 100, inputTokens: 152, outputTokens: 10 },
      },
      wallClockMs: 20_000,
      workItems: ["AURA-123"],
    });
  });

  it("counts reprompts and interrupts, and opens turns for sdk prompts without either", () => {
    const content = [
      prompt("2026-08-20T10:00:00.000Z", "start work"),
      prompt("2026-08-20T10:00:10.000Z", "actually do X"),
      record({
        message: {
          content: [{ text: "[Request interrupted by user]", type: "text" }],
          role: "user",
        },
        timestamp: "2026-08-20T10:00:20.000Z",
      }),
      prompt("2026-08-20T10:00:30.000Z", "task notification", { promptSource: "sdk" }),
    ].join("\n");

    const session = parseClaudeSession(content, false);

    expect(session?.turns).toBe(3);
    expect(session?.completedTurns).toBe(0);
    expect(session?.abortedTurns).toBe(1);
    expect(session?.userMessages).toBe(2);
    expect(session?.interventions).toEqual([
      { kind: "reprompt", line: 2, turnIndex: 1 },
      { kind: "interrupt", line: 3, turnIndex: 1 },
    ]);
    expect(session?.turnDetails.map((turn) => turn.closed)).toEqual([
      "log-end",
      "aborted",
      "log-end",
    ]);
    expect(session?.inferredOutcome).toEqual({ confidence: "low", status: "abandoned" });
  });

  it("keeps sidecars, attachments, meta prompts, and compact summaries out of the turn count", () => {
    const content = [
      JSON.stringify({ leafUuid: "leaf-1", sessionId: "session-1", type: "last-prompt" }),
      record({
        attachment: { type: "output_style" },
        timestamp: "2026-08-20T09:59:00.000Z",
        type: "attachment",
      }),
      prompt("2026-08-20T10:00:01.000Z", "ignore me", { isMeta: true }),
      prompt("2026-08-20T10:00:02.000Z", "continued from summary", { isCompactSummary: true }),
      prompt("2026-08-20T10:00:03.000Z", "real prompt"),
    ].join("\n");

    const session = parseClaudeSession(content, false);

    expect(session?.turns).toBe(1);
    expect(session?.compactions).toBe(1);
    expect(session?.userMessages).toBe(1);
    expect(session?.initialPromptLines).toEqual([5]);
    // The attachment carries the envelope, so it extends the recorded wall-clock span.
    expect(session?.startedAt).toBe("2026-08-20T09:59:00.000Z");
    expect(session?.malformedLines).toBe(0);
  });

  it("skips sidechain records entirely", () => {
    const content = [
      prompt("2026-08-20T10:00:00.000Z", "main thread"),
      prompt("2026-08-20T10:00:05.000Z", "subagent prompt", { isSidechain: true }),
    ].join("\n");

    const session = parseClaudeSession(content, false);

    expect(session?.turns).toBe(1);
    expect(session?.userMessages).toBe(1);
    expect(session?.interventions).toEqual([]);
  });

  it("returns undefined for a file with no recognizable conversation records", () => {
    const content = [
      "not json at all",
      JSON.stringify({ aiTitle: "title only", sessionId: "session-1", type: "ai-title" }),
      JSON.stringify({ mode: "normal", sessionId: "session-1", type: "mode" }),
    ].join("\n");

    expect(parseClaudeSession(content, false)).toBeUndefined();
  });

  it("collects pull requests from pr-link records and issue keys from the branch", () => {
    const content = [
      prompt("2026-08-20T10:00:00.000Z", "ship it", { gitBranch: "feature/AURA-77-fix" }),
      JSON.stringify({
        prNumber: 7,
        prRepository: "org/repo",
        prUrl: "https://github.com/org/repo/pull/7",
        type: "pr-link",
      }),
    ].join("\n");

    const session = parseClaudeSession(content, false);

    expect(session?.pullRequests).toEqual(["https://github.com/org/repo/pull/7"]);
    expect(session?.git.branch).toBe("feature/AURA-77-fix");
    expect(session?.workItems).toContain("AURA-77");
  });
});
