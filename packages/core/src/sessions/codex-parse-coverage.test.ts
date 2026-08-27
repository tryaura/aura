import { describe, expect, it } from "vitest";

import { parseCodexSession } from "./codex-parse.js";

function line(timestamp: string, type: string, payload?: unknown): string {
  return JSON.stringify(payload === undefined ? { timestamp, type } : { payload, timestamp, type });
}

const META = line("2026-08-20T10:00:00.000Z", "session_meta", {
  cwd: "/repo/app",
  id: "session-1",
});

describe("Codex transcript coverage", () => {
  it("marks malformed lines partial without discarding recognized records", () => {
    const content = ["{not json", META, '"a string"', "[]"].join("\n");

    const session = parseCodexSession(content, false);

    expect(session?.sessionId).toBe("session-1");
    expect(session?.malformedLines).toBe(3);
    expect(session?.partial).toBe(true);
  });

  it("rejects unsafe numeric metrics before they can overflow the report", () => {
    const content = [
      META,
      line("2026-08-20T10:00:01.000Z", "event_msg", {
        turn_id: "one",
        type: "task_started",
      }),
      line("2026-08-20T10:00:02.000Z", "event_msg", {
        duration_ms: 1e308,
        turn_id: "one",
        type: "task_complete",
      }),
      line("2026-08-20T10:00:03.000Z", "event_msg", {
        turn_id: "two",
        type: "task_started",
      }),
      line("2026-08-20T10:00:04.000Z", "event_msg", {
        duration_ms: 1e308,
        turn_id: "two",
        type: "task_complete",
      }),
    ].join("\n");

    const session = parseCodexSession(content, false);

    expect(session?.agentTimeMs).toBe(2000);
    expect(session?.invalidValues).toBe(2);
    expect(session?.partial).toBe(true);
    expect(Number.isSafeInteger(session?.agentTimeMs)).toBe(true);
  });

  it("rejects an MCP duration whose combined fields exceed the duration bound", () => {
    const content = [
      META,
      line("2026-08-20T10:00:01.000Z", "event_msg", {
        duration: { nanos: 500_000_000, secs: 31_536_000 },
        invocation: { server: "linear", tool: "get_issue" },
        type: "mcp_tool_call_end",
      }),
    ].join("\n");

    const session = parseCodexSession(content, false);

    expect(session?.tools["mcp:linear.get_issue"]?.durationMs).toBe(0);
    expect(session?.invalidValues).toBe(1);
    expect(session?.partial).toBe(true);
  });
});
