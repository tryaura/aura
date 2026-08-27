import { describe, expect, it } from "vitest";

import { parseCodexSession } from "./codex-parse.js";

function record(timestamp: string, type: string, payload: unknown): string {
  return JSON.stringify({ payload, timestamp, type });
}

describe("async shell session parsing", () => {
  it("attributes a write_stdin completion to the command that started the process", () => {
    const content = [
      record("2026-08-20T10:00:00.000Z", "session_meta", { cwd: "/repo", id: "s1" }),
      record("2026-08-20T10:00:01.000Z", "response_item", {
        arguments: JSON.stringify({ cmd: "pnpm test" }),
        call_id: "exec-1",
        name: "exec_command",
        type: "function_call",
      }),
      record("2026-08-20T10:00:02.000Z", "response_item", {
        call_id: "exec-1",
        output: "Process running with session ID 42",
        type: "function_call_output",
      }),
      record("2026-08-20T10:00:03.000Z", "response_item", {
        arguments: JSON.stringify({ session_id: 42 }),
        call_id: "poll-1",
        name: "write_stdin",
        type: "function_call",
      }),
      record("2026-08-20T10:00:04.000Z", "response_item", {
        call_id: "poll-1",
        output: "Process exited with code 1\nTest Files 1 failed\nTests 2 failed",
        type: "function_call_output",
      }),
    ].join("\n");

    const session = parseCodexSession(content, false);

    expect(session?.tools).toEqual({ shell: { calls: 2, durationMs: 2000, failures: 1 } });
    expect(session?.outcomes).toMatchObject([
      {
        callLine: 2,
        kind: "check_failure",
        label: "pnpm",
        resultLine: 5,
        tool: "shell",
      },
    ]);
  });
});
