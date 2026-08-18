import type { AdapterSourceFile, McpSecretSighting } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { parseMcpServers } from "./mcp.js";
import { transformMcpSecrets } from "./mcp-secrets.js";

const SENTINEL = "sk-aura-codex-guided-sentinel";

describe("Codex MCP secret migration", () => {
  it("moves supported env and header literals while preserving unrelated TOML", () => {
    const content = `# keep this comment
model = "gpt-5"

[mcp_servers.docs]
command = "npx"
args = ["--token", "${SENTINEL}"]
env.DOCS_TOKEN = "${SENTINEL}"
env.lower_token = "${SENTINEL}"
env.REGION = "eu"
env_vars = [{ name = "REMOTE_TOKEN", source = "remote" }]

[mcp_servers.remote]
url = "https://example.com/mcp?token=${SENTINEL}"

[mcp_servers.remote.http_headers]
Authorization = "Bearer ${SENTINEL}"
"X-Api-Key" = "${SENTINEL}"
`;
    const sightings = sightingsFor(content);
    const rewritten = transformMcpSecrets.rewrite({
      content,
      sightings: sightings.filter(transformMcpSecrets.supports),
    });

    if ("refusal" in rewritten) {
      throw new Error(rewritten.refusal);
    }
    expect(rewritten.content).toContain("# keep this comment");
    expect(rewritten.content).toContain('model = "gpt-5"');
    expect(rewritten.content).toContain('name = "REMOTE_TOKEN"');
    expect(rewritten.content).toContain('"DOCS_TOKEN"');
    expect(rewritten.content).toContain("bearer_token_env_var = ");
    expect(rewritten.content).toContain("env_http_headers = ");
    expect(rewritten.content).toContain(`lower_token = "${SENTINEL}"`);
    expect(rewritten.content).toContain(`args = ["--token", "${SENTINEL}"]`);
    expect(rewritten.content).toContain(`url = "https://example.com/mcp?token=${SENTINEL}"`);
    expect(
      sightingsFor(rewritten.content)
        .map((sighting) => sighting.field)
        .sort(),
    ).toEqual(["args[1]", "env.lower_token", "url.query.token"]);
  });

  /*
   * TOML spells one server entry four ways and `smol-toml` resolves all of them, so detection sees
   * a credential in every shape here. A masker that only understood the standalone-table shape
   * returned the other three unchanged, and returned them as a success — which put the credential
   * straight into the rendered fix preview.
   */
  it.each([
    ["standalone table", `[mcp_servers.docs]\nenv.DOCS_TOKEN = "${SENTINEL}"\n`],
    [
      "nested env table",
      `[mcp_servers.docs]\ncommand = "npx"\n\n[mcp_servers.docs.env]\nDOCS_TOKEN = "${SENTINEL}"\n`,
    ],
    [
      "inline table under [mcp_servers]",
      `[mcp_servers]\ndocs = { command = "npx", env = { DOCS_TOKEN = "${SENTINEL}" } }\n`,
    ],
    [
      "top-level dotted key",
      `mcp_servers.docs = { command = "npx", env = { DOCS_TOKEN = "${SENTINEL}" } }\n`,
    ],
    [
      "dotted key under [mcp_servers]",
      `[mcp_servers]\ndocs.command = "npx"\ndocs.env.DOCS_TOKEN = "${SENTINEL}"\n`,
    ],
  ])("masks the credential when the entry is written as a %s", (_shape, content) => {
    const sightings = sightingsFor(content);
    expect(sightings).not.toEqual([]);

    const redaction = transformMcpSecrets.redact({ content, sightings });
    expect(redaction?.unresolved).toEqual([]);
    expect(redaction?.content).not.toContain(SENTINEL);
    expect(redaction?.content).toContain("[redacted]");
  });

  it("reports a sighting whose server the content does not contain instead of passing it", () => {
    const content = `[mcp_servers.other]\ncommand = "npx"\n`;
    const redaction = transformMcpSecrets.redact({
      content,
      sightings: [sighting("env.DOCS_TOKEN", { kind: "env", name: "DOCS_TOKEN" })],
    });

    expect(redaction?.unresolved).toEqual(["env.DOCS_TOKEN"]);
  });

  it("declines to rewrite an inline entry rather than reporting a field it did not move", () => {
    const content = `[mcp_servers]\ndocs = { command = "npx", env = { DOCS_TOKEN = "${SENTINEL}" } }\n`;
    const rewritten = transformMcpSecrets.rewrite({ content, sightings: sightingsFor(content) });

    expect("refusal" in rewritten ? [] : rewritten.rewrittenFields).toEqual([]);
  });

  it("refuses content that is not TOML instead of masking nothing", () => {
    expect(transformMcpSecrets.redact({ content: "[unterminated", sightings: [] })).toBeUndefined();
  });
});

function sightingsFor(content: string): readonly McpSecretSighting[] {
  return parseMcpServers(mcpFile(content)).secretSightings ?? [];
}

function sighting(field: string, locator: McpSecretSighting["locator"]): McpSecretSighting {
  return {
    appId: "codex",
    field,
    locator,
    recordPath: ["mcp_servers"],
    scope: "global",
    serverName: "docs",
    sourceId: "codex.mcp.global",
    suggestedEnvName: "DOCS_TOKEN",
  };
}

function mcpFile(content: string): AdapterSourceFile {
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
