import type { McpWriteResult, OwnedServerEntry } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { writeMcpServers } from "./mcp.js";

function content(result: McpWriteResult): string {
  if ("refusal" in result) {
    throw new Error(`expected content, got refusal: ${result.refusal}`);
  }
  return result.content;
}

describe("Claude Code MCP writing", () => {
  it("writes owned servers while preserving unrelated JSON and formatting", () => {
    const existing =
      '{\r\n    "theme": "dark",\r\n    "mcpServers": {\r\n        "owned": { "command": "old" },\r\n        "personal": { "command": "keep" }\r\n    }\r\n}\r\n';
    const output = content(
      writeMcpServers({
        desired: [
          {
            name: "owned",
            scope: "global",
            transport: { command: "npx", env: ["TOKEN"], type: "stdio" },
          },
        ],
        existingContent: existing,
        ledgerNames: ["owned"],
      }),
    );

    expect(output).toContain('"theme": "dark"');
    expect(output).toContain('"personal"');
    expect(output).toContain('"TOKEN": "${TOKEN}"');
    expect(output.replaceAll("\r\n", "")).not.toContain("\n");
    expect(
      content(writeMcpServers({ desired: [], existingContent: output, ledgerNames: ["owned"] })),
    ).not.toContain('"owned"');
  });

  it("leaves a file written on one line compact", () => {
    const output = content(
      writeMcpServers({
        desired: [{ name: "docs", scope: "global", transport: { command: "npx", type: "stdio" } }],
        existingContent: '{"theme":"dark","projects":{"/repo":{"history":[]}}}',
        ledgerNames: [],
      }),
    );

    expect(output).not.toContain("\n");
    expect(output).toContain('"docs":{"command":"npx"}');
  });

  it("refuses malformed JSON and unowned same-name collisions", () => {
    const desired: readonly OwnedServerEntry[] = [
      { name: "docs", scope: "global", transport: { command: "new", type: "stdio" } },
    ];

    expect(writeMcpServers({ desired, existingContent: "{", ledgerNames: [] })).toEqual({
      refusal: expect.stringContaining("not a valid JSON object"),
    });
    expect(
      writeMcpServers({
        desired,
        existingContent: '{"mcpServers":{"docs":{"command":"old"}}}',
        ledgerNames: [],
      }),
    ).toEqual({ refusal: expect.stringContaining("outside Aura's ownership ledger") });
  });
});
