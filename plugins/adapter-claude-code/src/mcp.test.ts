import type { AdapterSourceFile } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { parseGlobalMcpServers, parseMcpServers } from "./mcp.js";
import { mcpFile } from "./mcp-fixture.js";

describe("Claude Code MCP configuration", () => {
  it("keeps the entries it understands when others in the same file are malformed", () => {
    const { malformed, servers } = parseMcpServers(
      mcpFile(
        JSON.stringify({
          mcpServers: {
            badArgs: { args: [1], command: "tool" },
            badHttp: { type: "http", url: 42 },
            good: { command: "tool" },
            unparsableUrl: { type: "http", url: "not a url" },
            websocket: { type: "ws", url: "wss://example.com" },
          },
        }),
      ),
    );

    expect(servers.map((server) => server.name)).toEqual(["good"]);
    // The document itself parsed; only individual entries were unusable, and reporting the file as
    // broken would send the user looking for a syntax error that is not there.
    expect(malformed).toBe(false);
  });

  it("records disabled servers and malformed enabled flags by name", () => {
    const { servers, unusable } = parseMcpServers(
      mcpFile(
        JSON.stringify({
          mcpServers: {
            disabled: { command: "off", enabled: false },
            malformed: { command: "bad", enabled: "yes" },
            ready: { command: "on", enabled: true },
          },
        }),
      ),
    );

    expect(servers.map((server) => server.name)).toEqual(["ready"]);
    expect(unusable.map((entry) => [entry.name, entry.reason])).toEqual([
      ["disabled", "disabled"],
      ["malformed", "disabled"],
    ]);
  });

  it.each([
    ["is not JSON at all", "{"],
    ["parses to something other than an object", "[]"],
  ])("reports a file that %s as malformed rather than as empty", (_case, content) => {
    expect(parseMcpServers(mcpFile(content))).toEqual({
      malformed: true,
      servers: [],
      unusable: [],
    });
    expect(parseGlobalMcpServers(mcpFile(content), "/workspace")).toEqual({
      globalServers: [],
      localServers: [],
      malformed: true,
      unusable: [],
    });
  });

  it("reports an unread file as empty rather than malformed", () => {
    const unread: AdapterSourceFile = { ...mcpFile(""), content: undefined };

    expect(parseMcpServers(unread)).toEqual({ malformed: false, servers: [], unusable: [] });
  });

  it("selects only the exact cwd project and preserves transport sanitization", () => {
    const { globalServers, localServers } = parseGlobalMcpServers(
      mcpFile(
        JSON.stringify({
          mcpServers: { everywhere: { command: "global-server" } },
          projects: {
            "/other": { mcpServers: { ignored: { command: "ignored-server" } } },
            "/workspace": {
              mcpServers: {
                local: {
                  headers: { Authorization: "Bearer ${LOCAL_TOKEN}" },
                  type: "http",
                  url: "https://local.example.com/mcp?token=inline-secret",
                },
              },
            },
            "/workspace-alias": {
              mcpServers: { alias: { command: "alias-server" } },
            },
          },
        }),
      ),
      "/workspace",
    );

    expect(globalServers.map((server) => server.name)).toEqual(["everywhere"]);
    // Project scope, but still filed against the global spec: `~/.claude.json` is where these live
    // and where a user edits them, and no other spec declares that path.
    expect(localServers).toEqual([
      {
        appId: "claude-code",
        name: "local",
        scope: "project",
        sourceId: "claude-code.mcp.global",
        transport: {
          headerEnvironmentVariables: ["LOCAL_TOKEN"],
          type: "http",
          url: "https://local.example.com/mcp?token=[redacted]",
        },
      },
    ]);
    expect(JSON.stringify(localServers)).not.toContain("inline-secret");
  });

  it.each([
    ["a malformed projects value", JSON.stringify({ projects: [] })],
    ["a missing cwd entry", JSON.stringify({ projects: { "/other": {} } })],
    ["a malformed cwd entry", JSON.stringify({ projects: { "/workspace": [] } })],
    ["a cwd entry spelled as a prefix", JSON.stringify({ projects: { "/work": {} } })],
  ])("returns no local servers for %s", (_case, content) => {
    const config = parseGlobalMcpServers(mcpFile(content), "/workspace");

    expect(config.localServers).toEqual([]);
    expect(config.malformed).toBe(false);
  });
});
