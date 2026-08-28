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

function usage(inputTokens: number, outputTokens: number): Record<string, unknown> {
  return {
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
}

function assistant(
  message: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): string {
  return record({
    message: {
      content: [{ text: "ok", type: "text" }],
      model: "claude-opus-5",
      role: "assistant",
      stop_reason: null,
      ...message,
    },
    type: "assistant",
    ...overrides,
  });
}

const PROMPT = record({ message: { content: "go", role: "user" }, promptSource: "typed" });

describe("parseClaudeSession usage", () => {
  it("counts usage once per message id across streamed block lines", () => {
    const content = [
      PROMPT,
      assistant({ id: "msg-1", usage: usage(10, 5) }),
      assistant({ id: "msg-1", usage: usage(10, 5) }),
      assistant({ id: "msg-1", usage: usage(10, 5) }),
      assistant({ id: "msg-2", usage: usage(20, 7) }),
    ].join("\n");

    const session = parseClaudeSession(content, false);

    expect(session?.tokens).toEqual({ cachedInputTokens: 0, inputTokens: 30, outputTokens: 12 });
  });

  it("falls back to the request id when the message has none", () => {
    const content = [
      PROMPT,
      assistant({ usage: usage(10, 5) }, { requestId: "req-1" }),
      assistant({ usage: usage(10, 5) }, { requestId: "req-1" }),
      assistant({ usage: usage(1, 1) }),
      assistant({ usage: usage(1, 1) }),
    ].join("\n");

    const session = parseClaudeSession(content, false);

    // The two unidentifiable records cannot be deduplicated, so each counts once.
    expect(session?.tokens).toEqual({ cachedInputTokens: 0, inputTokens: 12, outputTokens: 7 });
  });

  it("skips synthetic and API-error records entirely", () => {
    const content = [
      PROMPT,
      assistant({ id: "msg-1", model: "<synthetic>", usage: usage(10, 5) }),
      assistant({ id: "msg-2", usage: usage(10, 5) }, { isApiErrorMessage: true }),
    ].join("\n");

    const session = parseClaudeSession(content, false);

    expect(session?.tokens).toBeUndefined();
    expect(session?.model).toBeUndefined();
  });

  it("reads context occupancy from per-request totals, cached share included", () => {
    const content = [
      PROMPT,
      assistant({
        id: "msg-1",
        usage: {
          cache_creation_input_tokens: 40,
          cache_read_input_tokens: 100,
          input_tokens: 2,
          output_tokens: 8,
        },
      }),
      assistant({ id: "msg-2", usage: usage(500, 50) }),
    ].join("\n");

    const session = parseClaudeSession(content, false);

    expect(session?.context).toEqual({
      initialContextTokens: 142,
      modelContextWindow: undefined,
      peakRequestTokens: 550,
    });
  });

  it("rejects out-of-bounds usage numbers and marks the session partial", () => {
    const content = [PROMPT, assistant({ id: "msg-1", usage: usage(-5, 5) })].join("\n");

    const session = parseClaudeSession(content, false);

    expect(session?.tokens).toEqual({ cachedInputTokens: 0, inputTokens: 0, outputTokens: 5 });
    expect(session?.invalidValues).toBe(1);
    expect(session?.partial).toBe(true);
  });
});
