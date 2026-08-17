import type { AdapterSourceFile } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { codexAdapter } from "./adapter.js";
import { parseMcpServers } from "./mcp.js";

describe("Codex MCP configuration", () => {
  it("normalizes stdio and HTTP servers without retaining secrets", () => {
    const { servers } = parseMcpServers(
      mcpFile(`
[mcp_servers.docs]
command = "npx"
args = ["-y", "@example/docs", "--api-key=sk-fixture-secret"]
env = { DOCS_TOKEN = "inline-secret", REGION = "eu" }
env_vars = ["LOCAL_TOKEN", { name = "REMOTE_TOKEN", source = "remote" }]

[mcp_servers.sentry]
url = "https://admin:hunter2@mcp.sentry.dev/mcp?team=acme#secret"
bearer_token_env_var = "SENTRY_TOKEN"
http_headers = { "X-Static-Key" = "inline-secret" }
env_http_headers = { Authorization = "AUTH_TOKEN", "X-Region" = "REGION" }
`),
    );

    expect(servers).toEqual([
      {
        appId: "codex",
        name: "docs",
        scope: "global",
        sourceId: "codex.mcp.global",
        transport: {
          args: ["-y", "@example/docs", "--api-key=[redacted]"],
          command: "npx",
          environmentVariables: ["DOCS_TOKEN", "LOCAL_TOKEN", "REGION", "REMOTE_TOKEN"],
          type: "stdio",
        },
      },
      {
        appId: "codex",
        name: "sentry",
        scope: "global",
        sourceId: "codex.mcp.global",
        transport: {
          headerEnvironmentVariables: ["AUTH_TOKEN", "REGION", "SENTRY_TOKEN"],
          type: "http",
          url: "https://mcp.sentry.dev/mcp?team=[redacted]",
        },
      },
    ]);
    const serialized = JSON.stringify(servers);
    expect(serialized).not.toContain("inline-secret");
    expect(serialized).not.toContain("sk-fixture-secret");
    expect(serialized).not.toContain("hunter2");
  });

  it("omits disabled servers and returns partial results for malformed entries", () => {
    const { servers } = parseMcpServers(
      mcpFile(`
[mcp_servers.good]
command = "tool"

[mcp_servers.disabled]
command = "disabled-tool"
enabled = false

[mcp_servers.ambiguous]
command = "tool"
url = "https://example.com/mcp"

[mcp_servers.bad_args]
command = "tool"
args = [1]

[mcp_servers.bad_enabled]
command = "tool"
enabled = "yes"

[mcp_servers.bad_headers]
url = "https://example.com/mcp"
http_headers = { Authorization = 42 }

[mcp_servers.bad_url]
url = "not a url"
`),
    );

    expect(servers.map((server) => server.name)).toEqual(["good"]);
  });

  it("redacts separate and bare argument credentials", () => {
    const { servers } = parseMcpServers(
      mcpFile(`
[mcp_servers.secrets]
command = "npx"
args = ["@example/mcp", "--token", "plain-secret", "ghp_deadbeef", "--verbose"]
`),
    );

    expect(servers[0]?.transport).toEqual({
      args: ["@example/mcp", "--token", "[redacted]", "[redacted]", "--verbose"],
      command: "npx",
      type: "stdio",
    });
  });

  it("distinguishes a config without servers from one that does not parse", () => {
    expect(parseMcpServers(mcpFile('model = "gpt"\n'))).toEqual({ malformed: false, servers: [] });
    expect(parseMcpServers(mcpFile("[mcp_servers"))).toEqual({ malformed: true, servers: [] });
    expect(parseMcpServers(mcpFile(undefined))).toEqual({ malformed: false, servers: [] });
  });

  it("reports a config.toml that does not parse instead of claiming no servers", () => {
    const config = mcpFile("[mcp_servers\nbroken =");
    const snapshot = codexAdapter.parse({
      cwd: "/workspace",
      detection: { installed: true },
      files: new Map([[config.spec.id, config]]),
      homeDir: "/home/dev",
    });

    expect(snapshot.mcpServers).toEqual([]);
    expect(snapshot.problems).toEqual([
      {
        message:
          "Codex's configuration at /home/dev/.codex/config.toml is not valid TOML, so Codex ignores the entire file: none of the MCP servers, project trust entries, or other settings it declares are in effect. Fix the file to restore them.",
        sourceId: "codex.mcp.global",
      },
    ]);
  });

  it("marks trust unreadable rather than unknown when the file does not parse", () => {
    const config = mcpFile("[mcp_servers\nbroken =");
    const snapshot = codexAdapter.parse({
      cwd: "/workspace",
      detection: { installed: true },
      files: new Map([[config.spec.id, config]]),
      homeDir: "/home/dev",
      projectRoot: "/workspace",
    });

    // One broken file must not also read as a deliberate "this project is untrusted": the problem
    // above already names the cause, and ENV-004 defers on "unreadable".
    expect(snapshot.metadata?.["projectTrust"]).toBe("unreadable");
  });

  it("still reports unknown trust when the file is present but core could not read it", () => {
    const config = mcpFile(undefined);
    const snapshot = codexAdapter.parse({
      cwd: "/workspace",
      detection: { installed: true },
      files: new Map([[config.spec.id, config]]),
      homeDir: "/home/dev",
      projectRoot: "/workspace",
    });

    expect(snapshot.metadata?.["projectTrust"]).toBe("unknown");
    expect(snapshot.problems).toEqual([]);
  });
});

function mcpFile(content: string | undefined): AdapterSourceFile {
  return {
    content,
    exists: true,
    spec: {
      id: "codex.mcp.global",
      kind: "mcp",
      path: "/home/dev/.codex/config.toml",
      scope: "global",
    },
  };
}
