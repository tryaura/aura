import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  defineAdapter,
  defineCheck,
  definePlugin,
  jsonMcpEntry,
  parseJsonMcpServers,
  writeJsonMcpServers,
  type Adapter,
  type AuraManifest,
  type AuraPlugin,
  type McpServerManifest,
} from "@tryaura/aura-sdk";
import { createPluginRegistry, parseAuraManifest } from "@tryaura/core";
import { afterEach, describe, expect, it } from "vitest";

import { runSetup } from "./setup.js";
import { mcpStep } from "./steps/mcp.js";
import { cleanupFixtures, createFixture } from "./testing.js";
import type { WizardAnswers } from "./wizard-types.js";

afterEach(cleanupFixtures);

describe("MCP setup integration", () => {
  it("converges a catalog server into two selected adapters and is a no-op on the next run", async () => {
    const fixture = await createFixture();
    const definitionPath = join(fixture.workspace, "github-mcp.json");
    await writeFile(definitionPath, JSON.stringify(githubDefinition()), "utf8");
    await writeManifest(fixture.homeDir, initialManifest());
    const registry = createPluginRegistry([mcpPlugin(definitionPath)]);
    const first = fixture.request(registry, [
      optionAnswer("mcp-servers", ["catalog:fixture/github"]),
      {
        "mcp-apps": { kind: "options", values: ["claude-code", "cursor"] },
      },
    ]);

    const firstCode = await runSetup({ ...first, steps: [mcpStep] });
    expect(firstCode, fixture.output()).toBe(0);

    const claudePath = configPath(fixture.homeDir, "claude-code");
    const cursorPath = configPath(fixture.homeDir, "cursor");
    const codexPath = configPath(fixture.homeDir, "codex");
    const expected =
      '{\n  "mcpServers": {\n    "github": {\n      "type": "http",\n      "url": "https://api.githubcopilot.com/mcp/",\n      "headers": {\n        "Authorization": "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}"\n      }\n    }\n  }\n}\n';
    await expect(readFile(claudePath, "utf8")).resolves.toBe(expected);
    await expect(readFile(cursorPath, "utf8")).resolves.toBe(expected);
    await expect(readFile(codexPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const manifestText = await readFile(join(fixture.homeDir, "agents", "aura.json"), "utf8");
    const parsed = parseAuraManifest(manifestText, "manifest");
    expect(parsed.status === "ready" ? parsed.value.mcpServers : undefined).toEqual([
      {
        apps: ["claude-code", "cursor"],
        catalogId: "fixture/github",
        name: "github",
        scope: "global",
        transport: githubDefinition().transportTemplate,
      },
    ]);
    expect(parsed.status === "ready" ? parsed.value.ownership : undefined).toMatchObject({
      "claude-code": { mcpServerNames: ["github"] },
      codex: { mcpServerNames: [] },
      cursor: { mcpServerNames: ["github"] },
    });
    expect(fixture.output()).toContain("GITHUB_PERSONAL_ACCESS_TOKEN");

    const before = await Promise.all([
      readFile(claudePath, "utf8"),
      readFile(cursorPath, "utf8"),
      readFile(join(fixture.homeDir, "agents", "aura.json"), "utf8"),
    ]);
    const second = fixture.request(registry);
    await expect(runSetup({ ...second, steps: [mcpStep] })).resolves.toBe(0);
    await expect(
      Promise.all([
        readFile(claudePath, "utf8"),
        readFile(cursorPath, "utf8"),
        readFile(join(fixture.homeDir, "agents", "aura.json"), "utf8"),
      ]),
    ).resolves.toEqual(before);
  });

  it("round-trips an editable custom server and removes only Aura-owned configuration", async () => {
    const fixture = await createFixture();
    const definitionPath = join(fixture.workspace, "github-mcp.json");
    await writeFile(definitionPath, JSON.stringify(githubDefinition()), "utf8");
    const manifest: AuraManifest = {
      ...initialManifest(),
      mcpServers: [
        {
          apps: ["claude-code"],
          name: "custom-docs",
          scope: "global",
          transport: { command: "docs-mcp", type: "stdio" },
        },
      ],
      ownership: {
        "claude-code": { files: [], mcpServerNames: ["custom-docs"] },
      },
    };
    await writeManifest(fixture.homeDir, manifest);
    const config =
      '{\n  "mcpServers": {\n    "custom-docs": {\n      "command": "docs-mcp"\n    },\n    "foreign": {\n      "command": "keep-me"\n    }\n  }\n}\n';
    await writeFile(configPath(fixture.homeDir, "claude-code"), config, "utf8");
    const registry = createPluginRegistry([mcpPlugin(definitionPath)]);

    const seeded = fixture.request(registry);
    await expect(runSetup({ ...seeded, steps: [mcpStep] })).resolves.toBe(0);
    const normalized = await readFile(configPath(fixture.homeDir, "claude-code"), "utf8");
    expect(JSON.parse(normalized)).toEqual(JSON.parse(config));
    const reseeded = fixture.request(registry);
    await expect(runSetup({ ...reseeded, steps: [mcpStep] })).resolves.toBe(0);
    await expect(readFile(configPath(fixture.homeDir, "claude-code"), "utf8")).resolves.toBe(
      normalized,
    );

    const remove = fixture.request(registry, [optionAnswer("mcp-servers", [])]);
    await expect(runSetup({ ...remove, steps: [mcpStep] })).resolves.toBe(0);
    const remaining = JSON.parse(
      await readFile(configPath(fixture.homeDir, "claude-code"), "utf8"),
    );
    expect(remaining).toEqual({ mcpServers: { foreign: { command: "keep-me" } } });
    const manifestText = await readFile(join(fixture.homeDir, "agents", "aura.json"), "utf8");
    const parsed = parseAuraManifest(manifestText, "manifest");
    expect(parsed.status === "ready" ? parsed.value.mcpServers : undefined).toEqual([]);
    expect(
      parsed.status === "ready" ? parsed.value.ownership["claude-code"]?.mcpServerNames : undefined,
    ).toEqual([]);
  });
});

function mcpPlugin(definitionPath: string): AuraPlugin {
  return definePlugin({
    adapters: ["claude-code", "codex", "cursor"].map(adapter),
    apiVersion: 1,
    checks: [
      defineCheck({
        defaultSeverity: "error",
        detect: () => [],
        explain: "Fixture check.",
        fixability: "manual",
        id: "fixture/MCP-000",
        scope: "global",
        title: "Fixture MCP state is valid",
      }),
    ],
    id: "fixture",
    mcpCatalog: [
      {
        description: "Connect GitHub repositories with a personal token.",
        id: "fixture/github",
        kind: "mcp-server",
        name: "GitHub",
        source: { type: "file", url: pathToFileURL(definitionPath).href },
        version: "1.0.0",
      },
    ],
    name: "Fixture MCP",
    version: "1.0.0",
  });
}

function adapter(id: string): Adapter {
  return defineAdapter({
    detect: () => Promise.resolve({ installed: true, version: "1.0.0" }),
    displayName: id,
    files: ({ environment }) => [
      {
        id: `${id}.mcp.global`,
        kind: "mcp",
        optional: true,
        path: configPath(environment.homeDir, id),
        scope: "global",
      },
    ],
    id,
    mcpWrite: (input) =>
      writeJsonMcpServers(input, (entry) => jsonMcpEntry(entry, (name) => `\${${name}}`)),
    parse: ({ files }) => {
      const file = files.get(`${id}.mcp.global`);
      const parsed =
        file === undefined
          ? { servers: [], unusable: [] }
          : parseJsonMcpServers(file, {
              appId: id,
              variablePattern: /\$\{([A-Z_][A-Z0-9_]*)\}/gu,
            });
      return {
        instructionFiles: [],
        mcpServers: parsed.servers,
        skills: [],
        unusableMcpServers: parsed.unusable,
      };
    },
    supportedRange: ">=1 <2",
  });
}

function githubDefinition(): McpServerManifest {
  return {
    credentialEnv: [
      {
        description: "A GitHub personal access token.",
        name: "GITHUB_PERSONAL_ACCESS_TOKEN",
        setupUrl: "https://github.com/settings/personal-access-tokens",
      },
    ],
    description: "Connect GitHub repositories with a personal token.",
    docsUrl: "https://github.com/github/github-mcp-server",
    id: "fixture/github",
    name: "GitHub",
    schemaVersion: 1,
    serverName: "github",
    supportedApps: ["claude-code", "codex", "cursor"],
    transportTemplate: {
      headers: { Authorization: "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" },
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
    },
  };
}

function initialManifest(): AuraManifest {
  return {
    apps: {
      "claude-code": { managed: true },
      codex: { managed: true },
      cursor: { managed: true },
    },
    mcpServers: [],
    ownership: {},
    schemaVersion: 1,
    skills: [],
    snippets: [],
  };
}

async function writeManifest(homeDir: string, manifest: AuraManifest): Promise<void> {
  const directory = join(homeDir, "agents");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "aura.json"), `${JSON.stringify(manifest, undefined, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function configPath(homeDir: string, id: string): string {
  return join(homeDir, `.${id}-mcp.json`);
}

function optionAnswer(id: string, values: readonly string[]): WizardAnswers {
  return { [id]: { kind: "options", values } };
}
