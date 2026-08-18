import { describe, expect, it } from "vitest";

import { parseMcpServers, transformMcpSecrets } from "./mcp.js";
import { mcpFile } from "./mcp-fixture.js";

describe("Claude Code MCP credential redaction", () => {
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
          inlineCredentialValues: true,
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
          inlineCredentialValues: true,
          type: "stdio",
        },
      ],
      [
        "joined",
        {
          args: ["-y", "@example/mcp", "--api-key=[redacted]"],
          command: "npx",
          inlineCredentialValues: true,
          type: "stdio",
        },
      ],
      [
        "separate",
        {
          args: ["@example/mcp", "--token", "[redacted]", "--verbose"],
          command: "npx",
          inlineCredentialValues: true,
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
    ).toEqual({
      args: ["@example/mcp", "[redacted]", "--flag"],
      command: "npx",
      inlineCredentialValues: true,
      type: "stdio",
    });
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

  it("rewrites every sighting in a JSON file and masks both preview sides", () => {
    const sentinel = "sk-aura-guided-rewrite-sentinel";
    const content = `${JSON.stringify(
      {
        keep: true,
        mcpServers: {
          docs: {
            args: ["--api-key", sentinel],
            command: "npx",
            env: { API_TOKEN: sentinel },
            headers: { Authorization: `Bearer ${sentinel}` },
            url: `https://user:${sentinel}@example.com/mcp?token=${sentinel}`,
          },
        },
      },
      undefined,
      4,
    )}\n`;
    const parsed = parseMcpServers(mcpFile(content));
    const sightings = parsed.secretSightings ?? [];
    const rewritten = transformMcpSecrets.rewrite({ content, sightings });

    expect(rewritten).not.toHaveProperty("refusal");
    if ("refusal" in rewritten) {
      throw new Error(rewritten.refusal);
    }
    expect(rewritten.rewrittenFields).toHaveLength(sightings.length);
    expect(rewritten.content).toContain('    "keep": true');
    expect(rewritten.content).not.toContain(sentinel);
    expect(rewritten.content).toContain("${API_TOKEN}");
    expect(parseMcpServers(mcpFile(rewritten.content)).secretSightings ?? []).toEqual([]);
    for (const side of [content, rewritten.content]) {
      const redaction = transformMcpSecrets.redact({ content: side, sightings });
      expect(redaction?.unresolved).toEqual([]);
      expect(redaction?.content).not.toContain(sentinel);
    }
  });

  /*
   * `~/.claude.json` holds an entry per project the user has ever opened, and a scan only inspects
   * the invocation directory's — so a diff hunk can reach a credential no sighting names. Masking
   * only what was sighted left those in the preview.
   */
  it("masks credential-shaped values the scan never sighted", () => {
    const sentinel = "sk-aura-other-project-sentinel";
    const content = `${JSON.stringify({
      mcpServers: { docs: { command: "npx", env: { API_TOKEN: "sk-aura-scanned-sentinel" } } },
      projects: {
        "/some/other/project": {
          mcpServers: { other: { command: "npx", env: { API_TOKEN: sentinel } } },
        },
      },
    })}\n`;
    const sightings = parseMcpServers(mcpFile(content)).secretSightings ?? [];
    const redaction = transformMcpSecrets.redact({ content, sightings });

    expect(sightings.map((sighting) => sighting.field)).toEqual(["env.API_TOKEN"]);
    expect(redaction?.unresolved).toEqual([]);
    expect(redaction?.content).not.toContain(sentinel);
    expect(redaction?.content).not.toContain("sk-aura-scanned-sentinel");
  });

  it("reports a sighting whose record path the content does not contain", () => {
    const sightings =
      parseMcpServers(
        mcpFile(
          JSON.stringify({ mcpServers: { docs: { command: "npx", env: { API_TOKEN: "sk-x" } } } }),
        ),
      ).secretSightings ?? [];
    const redaction = transformMcpSecrets.redact({ content: "{}", sightings });

    expect(redaction?.unresolved).toEqual(["env.API_TOKEN"]);
  });
});
