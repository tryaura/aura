import { describe, expect, it } from "vitest";

import { parseCodexSession } from "./codex-parse.js";

function line(timestamp: string, type: string, payload?: unknown): string {
  return JSON.stringify(payload === undefined ? { timestamp, type } : { payload, timestamp, type });
}

const META = line("2026-08-20T10:00:00.000Z", "session_meta", {
  cwd: "/repo/app",
  id: "session-1",
});

describe("turn boundaries", () => {
  it("pairs completions by turn id and closes a dangling final turn at log end", () => {
    const content = [
      META,
      line("2026-08-20T10:00:01.000Z", "event_msg", { turn_id: "t1", type: "task_started" }),
      line("2026-08-20T10:00:05.000Z", "event_msg", {
        duration_ms: 4200,
        time_to_first_token_ms: 350,
        turn_id: "t1",
        type: "task_complete",
      }),
      line("2026-08-20T10:00:06.000Z", "event_msg", { turn_id: "t2", type: "task_started" }),
      line("2026-08-20T10:00:09.000Z", "event_msg", { type: "token_count" }),
    ].join("\n");

    const session = parseCodexSession(content, false);

    expect(session?.turns).toBe(2);
    expect(session?.completedTurns).toBe(1);
    expect(session?.abortedTurns).toBe(0);
    expect(session?.turnDetails).toEqual([
      expect.objectContaining({
        closed: "completed",
        durationMs: 4200,
        endedAt: "2026-08-20T10:00:05.000Z",
        index: 0,
        startedAt: "2026-08-20T10:00:01.000Z",
        timeToFirstTokenMs: 350,
        turnId: "t1",
      }),
      expect.objectContaining({
        closed: "log-end",
        durationMs: 3000,
        endedAt: "2026-08-20T10:00:09.000Z",
        index: 1,
        turnId: "t2",
      }),
    ]);
  });

  it("falls back to the open turn when a completion carries no turn id", () => {
    const content = [
      META,
      line("2026-08-20T10:00:01.000Z", "event_msg", { type: "task_started" }),
      line("2026-08-20T10:00:03.000Z", "event_msg", { duration_ms: 1500, type: "task_complete" }),
    ].join("\n");

    const session = parseCodexSession(content, false);

    expect(session?.turnDetails).toEqual([
      expect.objectContaining({ closed: "completed", durationMs: 1500, turnId: undefined }),
    ]);
  });

  it("marks an aborted turn and records the interruption as an intervention", () => {
    const content = [
      META,
      line("2026-08-20T10:00:01.000Z", "event_msg", { turn_id: "t1", type: "task_started" }),
      line("2026-08-20T10:00:31.000Z", "event_msg", {
        duration_ms: 30_000,
        reason: "interrupted",
        turn_id: "t1",
        type: "turn_aborted",
      }),
    ].join("\n");

    const session = parseCodexSession(content, false);

    expect(session?.abortedTurns).toBe(1);
    expect(session?.turnDetails).toEqual([
      expect.objectContaining({ closed: "aborted", durationMs: 30_000 }),
    ]);
    expect(session?.interventions).toEqual([{ kind: "interrupt", line: 3, turnIndex: 0 }]);
  });

  it("counts every user message after the first as a re-prompt", () => {
    const content = [
      META,
      line("2026-08-20T10:00:01.000Z", "event_msg", { type: "task_started" }),
      line("2026-08-20T10:00:01.500Z", "event_msg", { type: "user_message" }),
      line("2026-08-20T10:00:02.000Z", "event_msg", { duration_ms: 500, type: "task_complete" }),
      line("2026-08-20T10:00:05.000Z", "event_msg", { type: "user_message" }),
      line("2026-08-20T10:00:06.000Z", "event_msg", { type: "task_started" }),
    ].join("\n");

    const session = parseCodexSession(content, false);

    expect(session?.userMessages).toBe(2);
    expect(session?.interventions).toEqual([{ kind: "reprompt", line: 5, turnIndex: 1 }]);
  });

  it("stamps the model a turn_context record names onto the session and its turns", () => {
    const content = [
      META,
      line("2026-08-20T10:00:00.500Z", "turn_context", { model: "gpt-5.4", turn_id: "t1" }),
      line("2026-08-20T10:00:01.000Z", "event_msg", { turn_id: "t1", type: "task_started" }),
    ].join("\n");

    const session = parseCodexSession(content, false);

    expect(session?.model).toBe("gpt-5.4");
    expect(session?.turnDetails).toEqual([expect.objectContaining({ model: "gpt-5.4" })]);
  });

  it("folds per-request token deltas into the open turn and tracks window occupancy", () => {
    const usage = (input: number, cached: number, output: number): unknown => ({
      info: {
        last_token_usage: {
          cached_input_tokens: cached,
          input_tokens: input,
          output_tokens: output,
          total_tokens: input + output,
        },
        model_context_window: 258_400,
        total_token_usage: {
          cached_input_tokens: cached,
          input_tokens: input,
          output_tokens: output,
        },
      },
      type: "token_count",
    });
    const content = [
      META,
      line("2026-08-20T10:00:01.000Z", "event_msg", { type: "task_started" }),
      line("2026-08-20T10:00:02.000Z", "event_msg", usage(14_906, 0, 548)),
      line("2026-08-20T10:00:03.000Z", "event_msg", usage(16_000, 15_000, 700)),
      line("2026-08-20T10:00:04.000Z", "event_msg", { duration_ms: 3000, type: "task_complete" }),
    ].join("\n");

    const session = parseCodexSession(content, false);

    expect(session?.context).toEqual({
      initialContextTokens: 14_906,
      modelContextWindow: 258_400,
      peakRequestTokens: 16_700,
    });
    expect(session?.turnDetails[0]?.tokens).toEqual({
      cachedInputTokens: 15_000,
      inputTokens: 30_906,
      outputTokens: 1248,
    });
  });

  it("counts recorded patch applications and the files they touched", () => {
    const content = [
      META,
      line("2026-08-20T10:00:01.000Z", "event_msg", {
        changes: { "/repo/a.ts": { type: "update" }, "/repo/b.ts": { type: "add" } },
        success: true,
        type: "patch_apply_end",
      }),
      line("2026-08-20T10:00:02.000Z", "event_msg", {
        changes: { "/repo/a.ts": { type: "update" } },
        success: false,
        type: "patch_apply_end",
      }),
    ].join("\n");

    const session = parseCodexSession(content, false);

    expect(session?.edits).toEqual({ applied: 1, failed: 1, files: 3 });
  });

  it("records an approval request as an intervention", () => {
    const content = [
      META,
      line("2026-08-20T10:00:01.000Z", "event_msg", { type: "task_started" }),
      line("2026-08-20T10:00:02.000Z", "event_msg", { type: "exec_approval_request" }),
    ].join("\n");

    const session = parseCodexSession(content, false);

    expect(session?.interventions).toEqual([{ kind: "approval", line: 3, turnIndex: 0 }]);
  });

  it("keeps counting turns past the detail cap and flags the truncation", () => {
    const starts = Array.from({ length: 502 }, (unused, index) =>
      line(
        `2026-08-20T10:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        "event_msg",
        {
          type: "task_started",
        },
      ),
    );
    const session = parseCodexSession([META, ...starts].join("\n"), false);

    expect(session?.turns).toBe(502);
    expect(session?.turnDetails).toHaveLength(500);
    expect(session?.turnsTruncated).toBe(true);
  });
});
