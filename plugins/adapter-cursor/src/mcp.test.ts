import type { AdapterSourceFile } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { parseMcpServers, transformMcpSecrets, writeMcpServers } from "./mcp.js";

describe("Cursor MCP configuration", () => {
  it("normalizes stdio and remote servers without retaining secret values", () => {
    const { servers } = parseMcpServers(
      mcpFile(
        JSON.stringify({
          mcpServers: {
            docs: {
              args: ["-y", "@example/docs", "--api-key", "sk-fixture-secret"],
              command: "npx",
              env: { DOCS_TOKEN: "${env:DOCS_TOKEN}" },
              envFile: "${workspaceFolder}/.env",
              type: "stdio",
            },
            sentry: {
              auth: { CLIENT_SECRET: "inline-secret" },
              headers: { Authorization: "Bearer ${env:SENTRY_TOKEN}" },
              url: "https://mcp.sentry.dev?token=inline-secret",
            },
          },
        }),
      ),
    );

    expect(servers).toEqual([
      {
        appId: "cursor",
        name: "docs",
        scope: "project",
        sourceId: "cursor.mcp.project",
        transport: {
          args: ["-y", "@example/docs", "--api-key", "[redacted]"],
          command: "npx",
          environmentVariables: ["DOCS_TOKEN"],
          inlineCredentialValues: true,
          type: "stdio",
        },
      },
      {
        appId: "cursor",
        name: "sentry",
        scope: "project",
        sourceId: "cursor.mcp.project",
        transport: {
          headerEnvironmentVariables: ["SENTRY_TOKEN"],
          type: "http",
          url: "https://mcp.sentry.dev/?token=[redacted]",
        },
      },
    ]);
    const serialized = JSON.stringify(servers);
    expect(serialized).not.toContain("sk-fixture-secret");
    expect(serialized).not.toContain("inline-secret");
  });

  it("recognizes explicit HTTP and SSE transports and omits malformed entries", () => {
    const { servers } = parseMcpServers(
      mcpFile(
        JSON.stringify({
          mcpServers: {
            badArgs: { args: [1], command: "tool" },
            badUrl: { type: "http", url: "not a URL" },
            http: { type: "http", url: "https://http.example.com/mcp" },
            pathToken: { type: "http", url: "https://mcp.example.com/sse/sk-live-secret" },
            sse: { type: "sse", url: "https://sse.example.com/mcp" },
            websocket: { type: "ws", url: "wss://example.com" },
          },
        }),
      ),
    );

    expect(servers.map((server) => [server.name, server.transport])).toEqual([
      ["http", { type: "http", url: "https://http.example.com/mcp" }],
      ["pathToken", { type: "http", url: "https://mcp.example.com/sse/[redacted]" }],
      ["sse", { type: "sse", url: "https://sse.example.com/mcp" }],
    ]);
  });

  it("distinguishes a config without servers from one that does not parse", () => {
    expect(parseMcpServers(mcpFile("{}"))).toEqual({ malformed: false, servers: [], unusable: [] });
    expect(parseMcpServers(mcpFile("{"))).toEqual({ malformed: true, servers: [], unusable: [] });
    expect(parseMcpServers(mcpFile("[1, 2]"))).toEqual({
      malformed: true,
      servers: [],
      unusable: [],
    });
  });

  it("records a disabled entry rather than dropping its name", () => {
    const parsed = parseMcpServers(
      mcpFile(
        JSON.stringify({
          mcpServers: {
            disabled: { command: "off", enabled: false },
            ready: { command: "on" },
          },
        }),
      ),
    );

    expect(parsed.servers.map((server) => server.name)).toEqual(["ready"]);
    expect(parsed.unusable).toEqual([
      {
        appId: "cursor",
        name: "disabled",
        reason: "disabled",
        scope: "project",
        sourceId: "cursor.mcp.project",
      },
    ]);
  });

  it("flags an entry that stores a credential where a reference belongs", () => {
    const parsed = parseMcpServers(
      mcpFile(
        JSON.stringify({
          mcpServers: {
            inline: { command: "npx", env: { TOKEN: "sk-live-secret" } },
            referenced: { command: "npx", env: { TOKEN: "${env:TOKEN}" } },
          },
        }),
      ),
    );

    expect(parsed.servers.map((server) => server.transport.inlineCredentialValues)).toEqual([
      true,
      undefined,
    ]);
  });

  it("rewrites all representable literals using Cursor references", () => {
    const sentinel = "sk-aura-cursor-guided-sentinel";
    const content = `${JSON.stringify({
      mcpServers: {
        docs: {
          args: [`--api-key=${sentinel}`],
          command: "npx",
          env: { API_TOKEN: sentinel },
          headers: { Authorization: `Bearer ${sentinel}` },
        },
      },
    })}\n`;
    const sightings = parseMcpServers(mcpFile(content)).secretSightings ?? [];
    const rewritten = transformMcpSecrets.rewrite({ content, sightings });

    if ("refusal" in rewritten) {
      throw new Error(rewritten.refusal);
    }
    expect(rewritten.rewrittenFields).toHaveLength(3);
    expect(rewritten.content).not.toContain(sentinel);
    expect(rewritten.content).toContain("${env:API_TOKEN}");
    expect(parseMcpServers(mcpFile(rewritten.content)).secretSightings ?? []).toEqual([]);
  });

  it("writes Cursor environment references", () => {
    const result = writeMcpServers({
      desired: [
        {
          name: "remote",
          scope: "project",
          transport: {
            headers: { Authorization: "Bearer ${TOKEN}" },
            type: "http",
            url: "https://example.com/mcp",
          },
        },
      ],
      existingContent: "{}\n",
      ledgerNames: [],
    });

    expect(result).toEqual({ content: expect.stringContaining("Bearer ${env:TOKEN}") });
    expect(() => JSON.parse("content" in result ? result.content : "")).not.toThrow();
  });
});

function mcpFile(content: string): AdapterSourceFile {
  return {
    content,
    exists: true,
    spec: {
      id: "cursor.mcp.project",
      kind: "mcp",
      path: "/workspace/.cursor/mcp.json",
      scope: "project",
    },
  };
}
