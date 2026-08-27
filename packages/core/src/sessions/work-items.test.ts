import { describe, expect, it } from "vitest";

import { parseCodexSession } from "./codex-parse.js";
import { aggregateWorkItems } from "./work-item-aggregate.js";
import { collectWorkItems } from "./work-items.js";

function line(timestamp: string, type: string, payload?: unknown): string {
  return JSON.stringify(payload === undefined ? { timestamp, type } : { payload, timestamp, type });
}

describe("collectWorkItems", () => {
  it("extracts tracker-agnostic keys and skips acronym shapes", () => {
    const found = new Set<string>();
    collectWorkItems(found, "Fix AURA-123 and PROJ-9 per SHA-256 of UTF-8 text, see GPT-5");
    expect([...found]).toEqual(["AURA-123", "PROJ-9"]);
  });

  it("caps retention and never grows past the cap", () => {
    const found = new Set<string>();
    collectWorkItems(found, Array.from({ length: 20 }, (u, i) => `KEY-${i + 1}`).join(" "));
    expect(found.size).toBe(8);
    collectWorkItems(found, "MORE-1");
    expect(found.has("MORE-1")).toBe(false);
  });
});

describe("session work-item association", () => {
  it("finds keys in prompts, messages, branch names, and git commands, keeping keys only", () => {
    const content = [
      line("2026-08-20T10:00:00.000Z", "session_meta", {
        base_instructions: { text: "Deliver USE-77 today" },
        cwd: "/repo/app",
        git: { branch: "feature/AURA-123-fix" },
        id: "s1",
      }),
      line("2026-08-20T10:00:01.000Z", "event_msg", {
        message: "please also close PROJ-5",
        type: "user_message",
      }),
      line("2026-08-20T10:00:02.000Z", "response_item", {
        arguments: JSON.stringify({ cmd: "git checkout -b fix/ABC-9" }),
        call_id: "c1",
        name: "exec_command",
        type: "function_call",
      }),
      line("2026-08-20T10:00:03.000Z", "response_item", {
        call_id: "c1",
        output: "Switched to branch\nProcess exited with code 0",
        type: "function_call_output",
      }),
    ].join("\n");

    const session = parseCodexSession(content, false);

    expect(session?.workItems).toEqual(["USE-77", "PROJ-5", "ABC-9", "AURA-123"]);
    expect(JSON.stringify(session)).not.toContain("Deliver");
  });

  it("keeps pull-request URLs from successful gh output", () => {
    const content = [
      line("2026-08-20T10:00:00.000Z", "session_meta", { cwd: "/repo/app", id: "s1" }),
      line("2026-08-20T10:00:01.000Z", "response_item", {
        arguments: JSON.stringify({ cmd: "gh pr create --fill" }),
        call_id: "c1",
        name: "exec_command",
        type: "function_call",
      }),
      line("2026-08-20T10:00:02.000Z", "response_item", {
        call_id: "c1",
        output: "https://github.com/acme/app/pull/42\nProcess exited with code 0",
        type: "function_call_output",
      }),
    ].join("\n");

    expect(parseCodexSession(content, false)?.pullRequests).toEqual([
      "https://github.com/acme/app/pull/42",
    ]);
  });
});

describe("aggregateWorkItems", () => {
  it("joins sessions by key with first-to-last span and summed wall clock", () => {
    const base = parseCodexSession(
      [line("2026-08-20T10:00:00.000Z", "session_meta", { cwd: "/r", id: "s" })].join("\n"),
      false,
    );
    if (base === undefined) {
      throw new Error("fixture session failed to parse");
    }
    const aggregates = aggregateWorkItems([
      {
        ...base,
        endedAt: "2026-08-20T11:00:00.000Z",
        startedAt: "2026-08-20T10:00:00.000Z",
        wallClockMs: 100,
        workItems: ["AURA-1"],
      },
      {
        ...base,
        endedAt: "2026-08-21T12:00:00.000Z",
        startedAt: "2026-08-21T10:00:00.000Z",
        wallClockMs: 200,
        workItems: ["AURA-1", "AURA-2"],
      },
    ]);

    expect(aggregates).toEqual([
      {
        firstSeen: "2026-08-20T10:00:00.000Z",
        key: "AURA-1",
        lastSeen: "2026-08-21T12:00:00.000Z",
        sessions: 2,
        spanMs: 93_600_000,
        wallClockMs: 300,
      },
      {
        firstSeen: "2026-08-21T10:00:00.000Z",
        key: "AURA-2",
        lastSeen: "2026-08-21T12:00:00.000Z",
        sessions: 1,
        spanMs: 7_200_000,
        wallClockMs: 200,
      },
    ]);
  });
});
