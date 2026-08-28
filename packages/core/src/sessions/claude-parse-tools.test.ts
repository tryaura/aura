import { describe, expect, it } from "vitest";

import { parseClaudeSession } from "./claude-parse.js";

function record(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    cwd: "/repo/app",
    isSidechain: false,
    sessionId: "session-1",
    timestamp: "2026-08-20T10:00:00.000Z",
    type: "user",
    uuid: "uuid-0",
    ...overrides,
  });
}

const PROMPT = record({ message: { content: "go", role: "user" }, promptSource: "typed" });

function toolUse(
  timestamp: string,
  id: string,
  name: string,
  input: Record<string, unknown>,
): string {
  return record({
    message: {
      content: [{ id, input, name, type: "tool_use" }],
      id: `msg-${id}`,
      model: "claude-opus-5",
      role: "assistant",
      stop_reason: "tool_use",
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
  overrides: Record<string, unknown> = {},
): string {
  return record({
    message: {
      content: [{ content, is_error: isError, tool_use_id: toolUseId, type: "tool_result" }],
      role: "user",
    },
    timestamp,
    ...overrides,
  });
}

describe("parseClaudeSession tools", () => {
  it("pairs calls with results and classifies structural failures by output", () => {
    const content = [
      PROMPT,
      toolUse("2026-08-20T10:00:01.000Z", "toolu-1", "Bash", { command: "pnpm test" }),
      toolResult("2026-08-20T10:00:04.000Z", "toolu-1", "FAIL src/app.test.ts", true),
    ].join("\n");

    const session = parseClaudeSession(content, false);

    expect(session?.tools).toEqual({ shell: { calls: 1, durationMs: 3000, failures: 1 } });
    expect(session?.validation).toEqual({
      attempts: 1,
      failures: 1,
      iterationsToFirstGreen: undefined,
      timeMs: 3000,
      tokensAtFirstGreen: undefined,
    });
    expect(session?.outcomes).toEqual([
      {
        callLine: 2,
        confidence: "high",
        exitCode: undefined,
        kind: "check_failure",
        label: "pnpm",
        reason: "a test runner executed and reported failing checks",
        resultLine: 3,
        tool: "shell",
      },
    ]);
  });

  it("labels compound commands as a shell batch when they fail", () => {
    const content = [
      PROMPT,
      toolUse("2026-08-20T10:00:01.000Z", "toolu-1", "Bash", {
        command: "pnpm build && pnpm test",
      }),
      toolResult("2026-08-20T10:00:02.000Z", "toolu-1", "boom", true),
    ].join("\n");

    const session = parseClaudeSession(content, false);

    expect(session?.outcomes).toEqual([
      {
        batchComponents: [
          { command: "pnpm", subcommand: "build" },
          { command: "pnpm", subcommand: "test" },
        ],
        callLine: 2,
        confidence: "low",
        exitCode: undefined,
        kind: "unknown_nonzero",
        label: "shell batch",
        reason: "a compound shell batch failed; the failing segment is not recorded",
        resultLine: 3,
        tool: "shell",
      },
    ]);
  });

  it("counts edits by outcome and by distinct file", () => {
    const content = [
      PROMPT,
      toolUse("2026-08-20T10:00:01.000Z", "toolu-1", "Edit", { file_path: "/repo/app/a.ts" }),
      toolResult("2026-08-20T10:00:02.000Z", "toolu-1", "ok"),
      toolUse("2026-08-20T10:00:03.000Z", "toolu-2", "Edit", { file_path: "/repo/app/a.ts" }),
      toolResult("2026-08-20T10:00:04.000Z", "toolu-2", "ok"),
      toolUse("2026-08-20T10:00:05.000Z", "toolu-3", "Write", { file_path: "/repo/app/b.ts" }),
      toolResult("2026-08-20T10:00:06.000Z", "toolu-3", "ok"),
      toolUse("2026-08-20T10:00:07.000Z", "toolu-4", "Edit", { file_path: "/repo/app/c.ts" }),
      toolResult("2026-08-20T10:00:08.000Z", "toolu-4", "old_string not found", true),
    ].join("\n");

    const session = parseClaudeSession(content, false);

    expect(session?.edits).toEqual({ applied: 3, failed: 1, files: 2 });
  });

  it("reads the bare toolUseResult string when the result block has no content", () => {
    const content = [
      PROMPT,
      toolUse("2026-08-20T10:00:01.000Z", "toolu-1", "Read", { file_path: "/gone.ts" }),
      toolResult("2026-08-20T10:00:02.000Z", "toolu-1", undefined, true, {
        toolUseResult: "Error: nope",
      }),
    ].join("\n");

    const session = parseClaudeSession(content, false);

    expect(session?.toolOutputChars).toBe(11);
    expect(session?.tools["Read"]?.failures).toBe(1);
  });

  it("keeps mcp tool names, renames Task to Agent, and flushes unpaired calls", () => {
    const content = [
      PROMPT,
      toolUse("2026-08-20T10:00:01.000Z", "toolu-1", "mcp__linear__get_issue", { id: "AURA-1" }),
      toolResult("2026-08-20T10:00:02.000Z", "toolu-1", [{ text: "found it", type: "text" }]),
      toolUse("2026-08-20T10:00:03.000Z", "toolu-2", "Task", { prompt: "explore" }),
      toolResult("2026-08-20T10:00:04.000Z", "toolu-2", "done"),
      toolUse("2026-08-20T10:00:05.000Z", "toolu-3", "ToolSearch", { query: "select:X" }),
    ].join("\n");

    const session = parseClaudeSession(content, false, "calls");

    expect(Object.keys(session?.tools ?? {}).sort()).toEqual([
      "Agent",
      "ToolSearch",
      "mcp__linear__get_issue",
    ]);
    expect(session?.calls?.find((call) => call.tool === "ToolSearch")?.status).toBe("unpaired");
    expect(session?.calls?.find((call) => call.tool === "Agent")?.status).toBe("ok");
  });

  it("classifies structurally failed MCP calls as operational tool errors", () => {
    const content = [
      PROMPT,
      toolUse("2026-08-20T10:00:01.000Z", "toolu-1", "mcp__linear__get_issue", {
        id: "AURA-1",
      }),
      toolResult("2026-08-20T10:00:02.000Z", "toolu-1", "MCP server unavailable", true),
    ].join("\n");

    const session = parseClaudeSession(content, false);

    expect(session?.outcomes).toEqual([
      {
        callLine: 2,
        confidence: "high",
        exitCode: undefined,
        kind: "tool_error",
        label: "mcp__linear__get_issue",
        reason: "the MCP runtime recorded an error result",
        resultLine: 3,
        tool: "mcp__linear__get_issue",
      },
    ]);
  });

  it("collects pull requests from successful gh output only", () => {
    const content = [
      PROMPT,
      toolUse("2026-08-20T10:00:01.000Z", "toolu-1", "Bash", { command: "gh pr create" }),
      toolResult("2026-08-20T10:00:02.000Z", "toolu-1", "https://github.com/org/repo/pull/9"),
      toolUse("2026-08-20T10:00:03.000Z", "toolu-2", "Bash", { command: "gh pr view" }),
      toolResult(
        "2026-08-20T10:00:04.000Z",
        "toolu-2",
        "https://github.com/org/repo/pull/10",
        true,
      ),
    ].join("\n");

    const session = parseClaudeSession(content, false);

    expect(session?.pullRequests).toEqual(["https://github.com/org/repo/pull/9"]);
  });
});
