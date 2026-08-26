import { describe, expect, it } from "vitest";

import { parseCodexSession } from "./codex-parse.js";

function line(timestamp: string, type: string, payload?: unknown): string {
  return JSON.stringify(payload === undefined ? { timestamp, type } : { payload, timestamp, type });
}

const META = line("2026-08-20T10:00:00.000Z", "session_meta", {
  cwd: "/repo/app",
  id: "session-1",
});

function execCall(at: string, callId: string, cmd: string): string {
  return line(at, "response_item", {
    arguments: JSON.stringify({ cmd }),
    call_id: callId,
    name: "exec_command",
    type: "function_call",
  });
}

function execOutput(at: string, callId: string, exitCode: number): string {
  return line(at, "response_item", {
    call_id: callId,
    output: `Wall time: 0.1 seconds\nProcess exited with code ${exitCode}\nOutput:\nx`,
    type: "function_call_output",
  });
}

function execOutputText(at: string, callId: string, exitCode: number, output: string): string {
  return line(at, "response_item", {
    call_id: callId,
    output: `Process exited with code ${exitCode}\nOutput:\n${output}`,
    type: "function_call_output",
  });
}

describe("parseCodexSession", () => {
  it("extracts identity, turns, tools, failures, and wall clock from a rollout", () => {
    const content = [
      META,
      line("2026-08-20T10:00:01.000Z", "event_msg", { type: "task_started" }),
      line("2026-08-20T10:00:01.000Z", "event_msg", { type: "user_message" }),
      execCall("2026-08-20T10:00:02.000Z", "call-1", "git status"),
      execOutput("2026-08-20T10:00:04.500Z", "call-1", 0),
      execCall("2026-08-20T10:00:05.000Z", "call-2", "/usr/bin/npm test"),
      execOutput("2026-08-20T10:00:06.000Z", "call-2", 1),
      line("2026-08-20T10:00:07.000Z", "event_msg", {
        duration: { nanos: 500_000_000, secs: 2 },
        invocation: JSON.stringify({ arguments: {}, server: "linear", tool: "get_issue" }),
        result: { Err: "boom" },
        type: "mcp_tool_call_end",
      }),
      line("2026-08-20T10:00:08.000Z", "compacted"),
      line("2026-08-20T10:00:09.000Z", "event_msg", {
        info: {
          total_token_usage: {
            cached_input_tokens: 900,
            input_tokens: 1000,
            output_tokens: 50,
          },
        },
        type: "token_count",
      }),
    ].join("\n");

    const session = parseCodexSession(content, false);

    expect(session).toEqual({
      agentTimeMs: 8000,
      abortedTurns: 0,
      commands: [
        {
          calls: 1,
          command: undefined,
          durationMs: 2500,
          failures: 1,
          subcommand: undefined,
          tool: "mcp:linear.get_issue",
          validation: false,
        },
        {
          calls: 1,
          command: "git",
          durationMs: 2500,
          failures: 0,
          subcommand: "status",
          tool: "shell",
          validation: false,
        },
        {
          calls: 1,
          command: "npm",
          durationMs: 1000,
          failures: 1,
          subcommand: "test",
          tool: "shell",
          validation: true,
        },
      ],
      compactions: 1,
      completedTurns: 0,
      context: undefined,
      cwd: "/repo/app",
      edits: undefined,
      endedAt: "2026-08-20T10:00:09.000Z",
      git: { branch: undefined, commitHash: undefined, repositoryUrl: undefined },
      inferredOutcome: { confidence: "low", status: "abandoned" },
      initialPromptChars: 0,
      initialPromptLines: [],
      interventions: [],
      largestToolOutputChars: 59,
      model: undefined,
      outcomes: [
        {
          callLine: 6,
          confidence: "low",
          exitCode: 1,
          kind: "unknown_nonzero",
          label: "npm",
          reason: "the command exited nonzero without a recognized outcome protocol",
          resultLine: 7,
          tool: "shell",
        },
        {
          callLine: 8,
          confidence: "high",
          exitCode: undefined,
          kind: "tool_error",
          label: "mcp:linear.get_issue",
          reason: "the MCP runtime recorded an error result",
          resultLine: 8,
          tool: "mcp:linear.get_issue",
        },
      ],
      pullRequests: [],
      sessionId: "session-1",
      source: "codex",
      startedAt: "2026-08-20T10:00:00.000Z",
      tokens: { cachedInputTokens: 900, inputTokens: 1000, outputTokens: 50 },
      toolOutputChars: 132,
      toolTimeMs: 6000,
      tools: {
        "mcp:linear.get_issue": { calls: 1, durationMs: 2500, failures: 1 },
        shell: { calls: 2, durationMs: 3500, failures: 1 },
      },
      truncated: false,
      turnDetails: [
        {
          closed: "log-end",
          durationMs: 8000,
          endedAt: "2026-08-20T10:00:09.000Z",
          index: 0,
          model: undefined,
          startedAt: "2026-08-20T10:00:01.000Z",
          timeToFirstTokenMs: undefined,
          tokens: undefined,
          toolCalls: 3,
          toolTimeMs: 6000,
          turnId: undefined,
        },
      ],
      turns: 1,
      turnsTruncated: false,
      userMessages: 1,
      validation: {
        attempts: 1,
        failures: 1,
        iterationsToFirstGreen: undefined,
        timeMs: 1000,
        tokensAtFirstGreen: undefined,
      },
      wallClockMs: 9000,
      workItems: [],
    });
  });

  it("skips malformed lines instead of failing the transcript", () => {
    const content = ["{not json", META, '"a string"', "[]"].join("\n");

    const session = parseCodexSession(content, false);
    expect(session?.sessionId).toBe("session-1");
  });

  it("returns undefined when nothing looks like a codex record", () => {
    expect(parseCodexSession("", false)).toBeUndefined();
    expect(parseCodexSession('{"kind":"other-log"}\n', false)).toBeUndefined();
  });

  it("drops the cut final line of a truncated read and marks the session", () => {
    const cut = line("2026-08-20T10:00:05.000Z", "event_msg", { type: "task_started" });
    const content = `${[META, line("2026-08-20T10:00:01.000Z", "event_msg", { type: "task_started" })].join("\n")}\n${cut.slice(0, 20)}`;

    const session = parseCodexSession(content, true);

    expect(session?.truncated).toBe(true);
    expect(session?.turns).toBe(1);
  });

  it("keeps the last reported quota state", () => {
    const content = [
      META,
      line("2026-08-20T10:00:01.000Z", "event_msg", {
        info: { total_token_usage: { cached_input_tokens: 1, input_tokens: 2, output_tokens: 3 } },
        rate_limits: { plan_type: "pro", primary: { used_percent: 3, window_minutes: 10_080 } },
        type: "token_count",
      }),
      line("2026-08-20T10:00:02.000Z", "event_msg", {
        info: { total_token_usage: { cached_input_tokens: 4, input_tokens: 5, output_tokens: 6 } },
        rate_limits: { plan_type: "pro", primary: { used_percent: 9, window_minutes: 10_080 } },
        type: "token_count",
      }),
    ].join("\n");

    const session = parseCodexSession(content, false);

    expect(session?.quota).toEqual({ planType: "pro", usedPercent: 9, windowMinutes: 10_080 });
    expect(session?.tokens).toEqual({ cachedInputTokens: 4, inputTokens: 5, outputTokens: 6 });
  });

  it("classifies known non-success protocols and keeps compound commands conservative", () => {
    const content = [
      META,
      execCall("2026-08-20T10:00:01.000Z", "tests", "pnpm test"),
      execOutputText(
        "2026-08-20T10:00:02.000Z",
        "tests",
        1,
        "Test Files  1 failed\nTests  2 failed",
      ),
      execCall("2026-08-20T10:00:03.000Z", "checks", "gh pr checks 42"),
      execOutputText("2026-08-20T10:00:04.000Z", "checks", 8, "build\tpending\t0"),
      execCall("2026-08-20T10:00:05.000Z", "search", "rg needle src"),
      execOutputText("2026-08-20T10:00:06.000Z", "search", 1, ""),
      execCall("2026-08-20T10:00:07.000Z", "batch", "sed -n '1p' file\nrg needle src"),
      execOutputText("2026-08-20T10:00:08.000Z", "batch", 1, "some file content"),
    ].join("\n");

    const session = parseCodexSession(content, false);

    expect(session?.outcomes).toMatchObject([
      { callLine: 2, confidence: "high", kind: "check_failure", label: "pnpm", resultLine: 3 },
      { callLine: 4, confidence: "high", kind: "pending_status", label: "gh", resultLine: 5 },
      { callLine: 6, confidence: "medium", kind: "no_match", label: "rg", resultLine: 7 },
      {
        callLine: 8,
        confidence: "low",
        kind: "unknown_nonzero",
        label: "shell batch",
        resultLine: 9,
      },
    ]);
  });

  it("retains historical git and initial prompt context", () => {
    const base = "base instructions";
    const developer = "project instructions";
    const content = [
      line("2026-08-20T10:00:00.000Z", "session_meta", {
        base_instructions: { text: base },
        cwd: "/repo/app",
        git: {
          branch: "feature/session-health",
          commit_hash: "abc123",
          repository_url: "https://example.com/repo.git",
        },
        id: "session-1",
      }),
      line("2026-08-20T10:00:01.000Z", "response_item", {
        content: developer,
        role: "developer",
        type: "message",
      }),
      execCall("2026-08-20T10:00:02.000Z", "call-1", "git status"),
      execOutput("2026-08-20T10:00:03.000Z", "call-1", 0),
      line("2026-08-20T10:00:04.000Z", "response_item", {
        content: "late user message",
        role: "user",
        type: "message",
      }),
    ].join("\n");

    const session = parseCodexSession(content, false);

    expect(session?.git).toEqual({
      branch: "feature/session-health",
      commitHash: "abc123",
      repositoryUrl: "https://example.com/repo.git",
    });
    expect(session?.initialPromptChars).toBe(base.length + developer.length);
    expect(session?.initialPromptLines).toEqual([1, 2]);
  });
});
