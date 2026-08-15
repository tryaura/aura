import { describe, expect, it } from "vitest";

import { redactMcpArguments, sanitizeMcpUrl } from "./mcp.js";

describe("MCP argument redaction", () => {
  it("redacts joined, separate, and recognizable bare credential values", () => {
    expect(
      redactMcpArguments([
        "@example/mcp",
        "--api-key=sk-live-abc",
        "--token",
        "plain-secret",
        "ghp_deadbeef",
        "--verbose",
      ]),
    ).toEqual([
      "@example/mcp",
      "--api-key=[redacted]",
      "--token",
      "[redacted]",
      "[redacted]",
      "--verbose",
    ]);
  });

  it("does not consume another flag as a secret value", () => {
    expect(redactMcpArguments(["--token", "--verbose"])).toEqual(["--token", "--verbose"]);
  });

  it("redacts credential-bearing header values passed as arguments", () => {
    expect(
      redactMcpArguments([
        "mcp-remote",
        "https://mcp.example.com/mcp",
        "--header",
        "Authorization: Bearer sk-live-abc",
        "--header",
        "X-Api-Key:abc123",
        "--header",
        "X-Trace-Id: 42",
      ]),
    ).toEqual([
      "mcp-remote",
      "https://mcp.example.com/mcp",
      "--header",
      "Authorization: [redacted]",
      "--header",
      "X-Api-Key: [redacted]",
      "--header",
      "X-Trace-Id: 42",
    ]);
  });

  it("redacts bearer values whatever name precedes them", () => {
    expect(redactMcpArguments(["--custom", "Bearer sk-live-abc"])).toEqual([
      "--custom",
      "[redacted]",
    ]);
  });
});

describe("MCP URL sanitization", () => {
  it("removes userinfo, fragments, and query values", () => {
    expect(sanitizeMcpUrl("https://user:secret@example.com/mcp?team=acme#token")).toBe(
      "https://example.com/mcp?team=[redacted]",
    );
  });

  it("refuses invalid URLs", () => {
    expect(sanitizeMcpUrl("not a url")).toBeUndefined();
  });
});
