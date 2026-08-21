import type { McpServerDef } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { buildWorkspaceModel } from "../index.js";
import { MAX_MCP_CATALOG_BYTES } from "./reader-limits.js";
import { createMemoryReader, createTestEnvironment, DIRECTORY } from "./testing.js";

const DEFINITION = {
  credentialEnv: [{ description: "Authenticates requests.", name: "GITHUB_TOKEN" }],
  description: "Fixture MCP server.",
  docsUrl: "https://example.test/github",
  id: "fixture/github",
  name: "GitHub",
  schemaVersion: 1,
  serverName: "github",
  transportTemplate: {
    args: ["-y", "@modelcontextprotocol/server-github"],
    command: "npx",
    env: ["GITHUB_TOKEN"],
    type: "stdio",
  },
};

const PATH = "/plugins/fixture/github.json";

describe("workspace MCP catalog", () => {
  it("loads and freezes every readable catalog definition", async () => {
    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [],
      environment: createTestEnvironment(),
      mcpCatalog: [entry()],
      reader: createMemoryReader({ [PATH]: JSON.stringify(DEFINITION) }),
    });

    expect(model.availableMcpServers).toEqual([{ ...entry(), manifest: DEFINITION }]);
    expect(Object.isFrozen(model.availableMcpServers[0])).toBe(true);
    expect(Object.isFrozen(model.availableMcpServers[0]?.manifest)).toBe(true);
    expect(diagnostics).toEqual([]);
  });

  it("reads each definition under a bound rather than the unbounded file limit", async () => {
    const reader = createMemoryReader({ [PATH]: JSON.stringify(DEFINITION) });

    await buildWorkspaceModel({
      adapters: [],
      environment: createTestEnvironment(),
      mcpCatalog: [entry()],
      reader,
    });

    expect(reader.reads).toContain(PATH);
  });

  it("names every catalog entry it had to drop, and why", async () => {
    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [],
      environment: createTestEnvironment(),
      mcpCatalog: [
        entry({ id: "fixture/missing", url: "file:///plugins/fixture/missing.json" }),
        entry({ id: "fixture/directory", url: "file:///plugins/fixture/directory.json" }),
        entry({ id: "fixture/unreadable", url: "file:///plugins/fixture/unreadable.json" }),
        entry({ id: "fixture/large", url: "file:///plugins/fixture/large.json" }),
        entry({ id: "fixture/malformed", url: "file:///plugins/fixture/malformed.json" }),
        entry({ id: "fixture/unsafe", url: "file:///plugins/fixture/unsafe.json" }),
        entry({ id: "fixture/mismatch", url: "file:///plugins/fixture/mismatch.json" }),
        entry({ id: "fixture/not-a-file", url: "https://example.test/github.json" }),
      ],
      reader: createMemoryReader(
        {
          "/plugins/fixture/directory.json": DIRECTORY,
          "/plugins/fixture/large.json": "x".repeat(MAX_MCP_CATALOG_BYTES + 1),
          "/plugins/fixture/malformed.json": "{broken",
          "/plugins/fixture/mismatch.json": JSON.stringify({
            ...DEFINITION,
            id: "fixture/mismatch",
            name: "Renamed",
          }),
          "/plugins/fixture/unreadable.json": JSON.stringify(DEFINITION),
          "/plugins/fixture/unsafe.json": JSON.stringify({
            ...DEFINITION,
            id: "fixture/unsafe",
            transportTemplate: { command: "npx", env: ["TOKEN=value"], type: "stdio" },
          }),
        },
        { problems: { "/plugins/fixture/unreadable.json": "denied" } },
      ),
    });

    expect(model.availableMcpServers).toEqual([]);
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      'MCP catalog entry "fixture/missing" points at a file that does not exist, so its definition is unavailable.',
      'MCP catalog entry "fixture/directory" points at a directory rather than a JSON file, so its definition is unavailable.',
      'MCP catalog entry "fixture/unreadable" could not be read (denied), so its definition is unavailable.',
      `MCP catalog entry "fixture/large" is larger than the ${String(MAX_MCP_CATALOG_BYTES)} byte catalog limit, so its definition is unavailable.`,
      'MCP catalog entry "fixture/malformed" is invalid at $: must be valid JSON, so its definition is unavailable.',
      'MCP catalog entry "fixture/unsafe" is invalid at $.transportTemplate.env[0]: must match /^[A-Z_][A-Z0-9_]*$/ and contain a name, never NAME=value, so its definition is unavailable.',
      'MCP catalog entry "fixture/mismatch" disagrees with its source file at $.name, so its definition is unavailable.',
      'MCP catalog entry "fixture/not-a-file" declares a source that is not an absolute file: URL, so its definition is unavailable.',
    ]);
    expect(new Set(diagnostics.map((diagnostic) => diagnostic.adapterId))).toEqual(
      new Set(["core/mcp-catalog"]),
    );
  });

  it("blames the compile step, not the filesystem, for a definition missing from a binary", async () => {
    const { diagnostics } = await buildWorkspaceModel({
      adapters: [],
      environment: createTestEnvironment(),
      mcpCatalog: [
        entry({ id: "fixture/embedded", url: "file:///$bunfs/root/content/mcp/github.json" }),
      ],
      reader: createMemoryReader({}),
    });

    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      'MCP catalog entry "fixture/embedded" was not embedded in this executable, so its definition is unavailable. Compile it with the catalog JSON as extra "bun build" entrypoints and "--loader .json:file".',
    ]);
  });

  it("keeps one unusable entry from hiding the rest of the catalog", async () => {
    const { model } = await buildWorkspaceModel({
      adapters: [],
      environment: createTestEnvironment(),
      mcpCatalog: [entry({ id: "fixture/missing", url: "file:///nowhere.json" }), entry()],
      reader: createMemoryReader({ [PATH]: JSON.stringify(DEFINITION) }),
    });

    expect(model.availableMcpServers.map((server) => server.id)).toEqual(["fixture/github"]);
  });

  it("retains only environment-variable availability from desired MCP transports", async () => {
    const manifestPath = "/home/dev/agents/aura.json";
    const manifest = {
      apps: {},
      mcpServers: [
        {
          apps: ["fake"],
          name: "docs",
          transport: { command: "docs", env: ["DOCS_TOKEN", "OTHER_TOKEN"], type: "stdio" },
        },
      ],
      ownership: {},
      schemaVersion: 1,
      skills: [],
      snippets: [],
    };
    const { model } = await buildWorkspaceModel({
      adapters: [],
      environment: createTestEnvironment({ variables: { DOCS_TOKEN: "secret-value" } }),
      reader: createMemoryReader({ [manifestPath]: JSON.stringify(manifest) }),
    });

    expect(model.mcpEnvironmentVariables).toEqual([
      { isSet: true, name: "DOCS_TOKEN" },
      { isSet: false, name: "OTHER_TOKEN" },
    ]);
    expect(JSON.stringify(model)).not.toContain("secret-value");
  });
});

function entry(overrides: { readonly id?: string; readonly url?: string } = {}): McpServerDef {
  return {
    description: "Fixture MCP server.",
    id: overrides.id ?? "fixture/github",
    kind: "mcp-server",
    name: "GitHub",
    source: { type: "file", url: overrides.url ?? `file://${PATH}` },
    version: "1.0.0",
  };
}
