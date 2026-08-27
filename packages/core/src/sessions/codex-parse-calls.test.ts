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

describe("call-level detail", () => {
  it("treats unrecognized tool output text as success", () => {
    const content = [
      META,
      execCall("2026-08-20T10:00:02.000Z", "call-1", "ls"),
      line("2026-08-20T10:00:03.000Z", "response_item", {
        call_id: "call-1",
        output: "plain text with no exit marker",
        type: "function_call_output",
      }),
    ].join("\n");

    const session = parseCodexSession(content, false);

    expect(session?.tools["shell"]).toEqual({ calls: 1, durationMs: 1000, failures: 0 });
  });

  it("counts paired MCP lifecycle records once and keeps the original call line", () => {
    const content = [
      META,
      line("2026-08-20T10:00:01.000Z", "response_item", {
        arguments: JSON.stringify({ issueId: "USE-1" }),
        call_id: "mcp-1",
        name: "_get_issue",
        type: "function_call",
      }),
      line("2026-08-20T10:00:02.000Z", "event_msg", {
        call_id: "mcp-1",
        duration: { nanos: 0, secs: 1 },
        invocation: JSON.stringify({ server: "linear", tool: "get_issue" }),
        result: { Err: "boom" },
        type: "mcp_tool_call_end",
      }),
      line("2026-08-20T10:00:03.000Z", "response_item", {
        call_id: "mcp-1",
        output: "later duplicate result",
        type: "function_call_output",
      }),
    ].join("\n");

    const session = parseCodexSession(content, false);

    expect(session?.tools).toEqual({
      "mcp:linear.get_issue": { calls: 1, durationMs: 1000, failures: 1 },
    });
    expect(session?.commands).toEqual([
      {
        calls: 1,
        command: undefined,
        durationMs: 1000,
        failures: 1,
        subcommand: undefined,
        tool: "mcp:linear.get_issue",
        validation: false,
      },
    ]);
    expect(session?.outcomes).toMatchObject([{ callLine: 2, kind: "tool_error", resultLine: 3 }]);
  });

  it("retains one row per call when asked for call detail, flagging unanswered calls", () => {
    const content = [
      META,
      line("2026-08-20T10:00:01.000Z", "event_msg", { type: "task_started" }),
      execCall("2026-08-20T10:00:02.000Z", "call-1", "git status"),
      line("2026-08-20T10:00:03.000Z", "response_item", {
        call_id: "call-1",
        output: "Process exited with code 1\nOutput:\nboom",
        type: "function_call_output",
      }),
      execCall("2026-08-20T10:00:04.000Z", "call-2", "npm test"),
    ].join("\n");

    const session = parseCodexSession(content, false, "calls");

    expect(session?.calls).toEqual([
      {
        callId: "call-1",
        callLine: 3,
        command: "git",
        durationMs: 1000,
        exitCode: 1,
        outputChars: 39,
        startedAt: "2026-08-20T10:00:02.000Z",
        status: "failure",
        subcommand: "status",
        tool: "shell",
        turnIndex: 0,
      },
      {
        callId: "call-2",
        callLine: 5,
        command: "npm",
        durationMs: undefined,
        exitCode: undefined,
        outputChars: 0,
        startedAt: "2026-08-20T10:00:04.000Z",
        status: "unpaired",
        subcommand: "test",
        tool: "shell",
        turnIndex: 0,
      },
    ]);
    expect(parseCodexSession(content, false)?.calls).toBeUndefined();
  });
});
