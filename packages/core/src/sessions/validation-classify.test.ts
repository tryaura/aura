import { describe, expect, it } from "vitest";

import { parseCodexSession } from "./codex-parse.js";
import { isValidationIdentity } from "./validation-classify.js";

function line(timestamp: string, type: string, payload?: unknown): string {
  return JSON.stringify(payload === undefined ? { timestamp, type } : { payload, timestamp, type });
}

const META = line("2026-08-20T10:00:00.000Z", "session_meta", { cwd: "/repo/app", id: "s1" });

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
    output: `Process exited with code ${exitCode}\nOutput:\nx`,
    type: "function_call_output",
  });
}

describe("isValidationIdentity", () => {
  it("recognizes validation subcommands, script prefixes, and bare runners", () => {
    expect(isValidationIdentity("pnpm", "test")).toBe(true);
    expect(isValidationIdentity("pnpm", "verify")).toBe(true);
    expect(isValidationIdentity("pnpm", "test:unit")).toBe(true);
    expect(isValidationIdentity("pnpm", "format:check")).toBe(true);
    expect(isValidationIdentity("cargo", "check")).toBe(true);
    expect(isValidationIdentity("go", "vet")).toBe(true);
    expect(isValidationIdentity("vitest", undefined)).toBe(true);
    expect(isValidationIdentity("tsc", undefined)).toBe(true);
  });

  it("stays false for ordinary work", () => {
    expect(isValidationIdentity("git", "checkout")).toBe(false);
    expect(isValidationIdentity("pnpm", "install")).toBe(false);
    expect(isValidationIdentity("git", undefined)).toBe(false);
    expect(isValidationIdentity(undefined, undefined)).toBe(false);
    expect(isValidationIdentity("shell batch", undefined)).toBe(false);
  });
});

describe("validation metrics", () => {
  it("tracks attempts, failures, time, and the first green run with its token snapshot", () => {
    const content = [
      META,
      execCall("2026-08-20T10:00:01.000Z", "v1", "pnpm test"),
      execOutput("2026-08-20T10:00:11.000Z", "v1", 1),
      line("2026-08-20T10:00:12.000Z", "event_msg", {
        info: {
          total_token_usage: { cached_input_tokens: 10, input_tokens: 100, output_tokens: 20 },
        },
        type: "token_count",
      }),
      execCall("2026-08-20T10:00:13.000Z", "v2", "pnpm test"),
      execOutput("2026-08-20T10:00:33.000Z", "v2", 0),
      execCall("2026-08-20T10:00:34.000Z", "v3", "pnpm verify"),
      execOutput("2026-08-20T10:00:39.000Z", "v3", 0),
    ].join("\n");

    const session = parseCodexSession(content, false);

    expect(session?.validation).toEqual({
      attempts: 3,
      failures: 1,
      iterationsToFirstGreen: 2,
      timeMs: 35_000,
      tokensAtFirstGreen: { cachedInputTokens: 10, inputTokens: 100, outputTokens: 20 },
    });
  });

  it("reports no validation metrics when nothing validation-shaped ran", () => {
    const content = [
      META,
      execCall("2026-08-20T10:00:01.000Z", "c1", "git status"),
      execOutput("2026-08-20T10:00:02.000Z", "c1", 0),
    ].join("\n");

    expect(parseCodexSession(content, false)?.validation).toBeUndefined();
  });
});
