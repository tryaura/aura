import type { AdapterSourceFile } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { parseGlobalMcpServers, parseMcpServers } from "./mcp.js";

describe("Claude Code MCP configuration", () => {
  it("normalizes top-level stdio and HTTP servers without retaining secret values", () => {
    const { servers } = parseMcpServers(
      mcpFile(
        JSON.stringify({
          mcpServers: {
            docs: {
              args: ["-y", "@example/docs"],
              command: "npx",
              env: { API_TOKEN: "inline-secret", TEAM: "${TEAM}" },
            },
            sentry: {
              headers: {
                Authorization: "Bearer ${SENTRY_TOKEN}",
                Optional: "${OPTIONAL_TOKEN:-fallback}",
              },
              type: "http",
              url: "https://mcp.sentry.dev",
            },
          },
          projects: {
            "/workspace": { mcpServers: { ignored: { command: "ignored" } } },
          },
        }),
      ),
    );

    expect(servers).toEqual([
      {
        appId: "claude-code",
        name: "docs",
        scope: "global",
        sourceId: "claude-code.mcp.global",
        transport: {
          args: ["-y", "@example/docs"],
          command: "npx",
          environmentVariables: ["API_TOKEN", "TEAM"],
          type: "stdio",
        },
      },
      {
        appId: "claude-code",
        name: "sentry",
        scope: "global",
        sourceId: "claude-code.mcp.global",
        transport: {
          headerEnvironmentVariables: ["OPTIONAL_TOKEN", "SENTRY_TOKEN"],
          type: "http",
          url: "https://mcp.sentry.dev/",
        },
      },
    ]);
    expect(JSON.stringify(servers)).not.toContain("inline-secret");
  });

  it("keeps credentials out of endpoints while leaving the server identifiable", () => {
    const { servers } = parseMcpServers(
      mcpFile(
        JSON.stringify({
          mcpServers: {
            fragment: { type: "http", url: "https://api.example.com/mcp#token-in-fragment" },
            query: { type: "http", url: "https://api.example.com/mcp?team=acme&token=sk-live-abc" },
            userinfo: { type: "http", url: "https://admin:hunter2@api.example.com/mcp" },
          },
        }),
      ),
    );

    expect(servers.map((server) => server.transport)).toEqual([
      { type: "http", url: "https://api.example.com/mcp" },
      { type: "http", url: "https://api.example.com/mcp?team=[redacted]&token=[redacted]" },
      { type: "http", url: "https://api.example.com/mcp" },
    ]);
    const serialized = JSON.stringify(servers);
    expect(serialized).not.toContain("sk-live-abc");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("token-in-fragment");
  });

  it("keeps credentials out of command arguments while leaving the package identifiable", () => {
    const { servers } = parseMcpServers(
      mcpFile(
        JSON.stringify({
          mcpServers: {
            docker: {
              args: ["run", "-e", "DOCS_TOKEN=t0ps3cret", "-e", "REGION=eu", "example/mcp"],
              command: "docker",
            },
            joined: { args: ["-y", "@example/mcp", "--api-key=sk-ant-abc"], command: "npx" },
            separate: {
              args: ["@example/mcp", "--token", "t0ps3cret", "--verbose"],
              command: "npx",
            },
            trailing: { args: ["@example/mcp", "--token"], command: "npx" },
          },
        }),
      ),
    );

    expect(servers.map((server) => [server.name, server.transport])).toEqual([
      [
        "docker",
        {
          args: ["run", "-e", "DOCS_TOKEN=[redacted]", "-e", "REGION=eu", "example/mcp"],
          command: "docker",
          type: "stdio",
        },
      ],
      [
        "joined",
        { args: ["-y", "@example/mcp", "--api-key=[redacted]"], command: "npx", type: "stdio" },
      ],
      [
        "separate",
        {
          args: ["@example/mcp", "--token", "[redacted]", "--verbose"],
          command: "npx",
          type: "stdio",
        },
      ],
      ["trailing", { args: ["@example/mcp", "--token"], command: "npx", type: "stdio" }],
    ]);
    expect(JSON.stringify(servers)).not.toContain("t0ps3cret");
    expect(JSON.stringify(servers)).not.toContain("sk-ant-abc");
  });

  it("redacts a bare credential whatever argument precedes it", () => {
    expect(
      parseMcpServers(
        mcpFile(
          JSON.stringify({
            mcpServers: {
              bare: { args: ["@example/mcp", "ghp_deadbeef", "--flag"], command: "npx" },
            },
          }),
        ),
      ).servers[0]?.transport,
    ).toEqual({ args: ["@example/mcp", "[redacted]", "--flag"], command: "npx", type: "stdio" });
  });

  it("recognizes SSE servers and HTTP servers that omit the transport type", () => {
    expect(
      parseMcpServers(
        mcpFile(
          JSON.stringify({
            mcpServers: {
              streaming: { type: "sse", url: "https://sse.example.com/mcp" },
              untyped: { url: "https://untyped.example.com/mcp" },
            },
          }),
        ),
      ).servers.map((server) => server.transport),
    ).toEqual([
      { type: "sse", url: "https://sse.example.com/mcp" },
      { type: "http", url: "https://untyped.example.com/mcp" },
    ]);
  });

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

  it.each([
    ["is not JSON at all", "{"],
    ["parses to something other than an object", "[]"],
  ])("reports a file that %s as malformed rather than as empty", (_case, content) => {
    expect(parseMcpServers(mcpFile(content))).toEqual({ malformed: true, servers: [] });
    expect(parseGlobalMcpServers(mcpFile(content), "/workspace")).toEqual({
      globalServers: [],
      localServers: [],
      malformed: true,
    });
  });

  it("reports an unread file as empty rather than malformed", () => {
    const unread: AdapterSourceFile = { ...mcpFile(""), content: undefined };

    expect(parseMcpServers(unread)).toEqual({ malformed: false, servers: [] });
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

function mcpFile(content: string): AdapterSourceFile {
  return {
    content,
    entries: undefined,
    exists: true,
    problem: undefined,
    spec: {
      id: "claude-code.mcp.global",
      kind: "mcp",
      path: "/home/dev/.claude.json",
      scope: "global",
    },
  };
}
