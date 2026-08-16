import { describe, expect, it } from "vitest";

import { canonicalAppId } from "./app-id.js";

describe("canonicalAppId", () => {
  it("resolves known aliases and normalizes case", () => {
    expect(canonicalAppId("claude")).toBe("claude-code");
    expect(canonicalAppId("CLAUDE_CODE")).toBe("claude-code");
    expect(canonicalAppId("Codex")).toBe("codex");
  });

  // The input is whatever a user typed at `--only`, so the lookup must not answer from a prototype.
  it("returns the normalized input for prototype-chain names", () => {
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(canonicalAppId(name)).toBe(name.toLowerCase());
    }
  });
});
