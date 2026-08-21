import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
} from "@tryaura/aura-sdk";
import { createPluginRegistry } from "@tryaura/core";
import { afterEach, describe, expect, it } from "vitest";

import { runSetup } from "./setup.js";
import { mcpStep } from "./steps/mcp.js";
import { cleanupFixtures, createFixture, type Fixture } from "./testing.js";
import type { WizardIo } from "./wizard-types.js";

afterEach(cleanupFixtures);

const RETRY_NOTE =
  "A configuration file changed while you were confirming; re-planning against its current contents.";

/*
 * Both tests stage the race a running application creates: the scan reads the MCP configuration
 * at boot, another process rewrites it while the wizard waits, and the plan must still apply
 * against — and preserve — the contents that are actually on disk.
 */
describe("MCP configuration race", () => {
  it("plans against the file as it is after the prompts, not as the boot scan read it", async () => {
    const fixture = await createFixture();
    await seed(fixture);
    const request = fixture.request(createPluginRegistry([plugin()]));
    const io = raceIo(request.io, "ask", () => rewriteConfig(fixture, "v2"));

    const code = await runSetup({ ...request, io, steps: [mcpStep] });

    expect(code, fixture.output()).toBe(0);
    const config = await parsedConfig(fixture);
    expect(config["bookkeeping"]).toBe("v2");
    expect(config["mcpServers"]).toMatchObject({
      "custom-docs": { command: "docs-mcp" },
      foreign: { command: "keep-me" },
    });
    expect(fixture.output()).not.toContain(RETRY_NOTE);
  });

  it("re-plans and applies when the file changes during the confirmation pause", async () => {
    const fixture = await createFixture();
    await seed(fixture);
    const request = fixture.request(createPluginRegistry([plugin()]));
    const io = raceIo(request.io, "confirm", () => rewriteConfig(fixture, "v3"));

    const code = await runSetup({ ...request, io, steps: [mcpStep] });

    expect(code, fixture.output()).toBe(0);
    const config = await parsedConfig(fixture);
    expect(config["bookkeeping"]).toBe("v3");
    expect(config["mcpServers"]).toMatchObject({
      "custom-docs": { command: "docs-mcp" },
      foreign: { command: "keep-me" },
    });
    expect(fixture.output().split(RETRY_NOTE)).toHaveLength(2);
  });
});

/** Delegates to the scripted io, rewriting the config file once at the chosen moment. */
function raceIo(io: WizardIo, when: "ask" | "confirm", mutate: () => Promise<void>): WizardIo {
  let mutated = false;
  const once = async (): Promise<void> => {
    if (!mutated) {
      mutated = true;
      await mutate();
    }
  };
  return {
    ask: async (questions, flow) => {
      if (when === "ask") {
        await once();
      }
      return io.ask(questions, flow);
    },
    confirm: async (prompt, flow) => {
      if (when === "confirm") {
        await once();
      }
      return io.confirm(prompt, flow);
    },
    load: (request, task, flow) => io.load(request, task, flow),
    note: (text) => {
      io.note(text);
    },
  };
}

async function seed(fixture: Fixture): Promise<void> {
  const manifest: AuraManifest = {
    apps: { "claude-code": { managed: true } },
    mcpServers: [
      {
        apps: ["claude-code"],
        name: "custom-docs",
        transport: { command: "docs-mcp", type: "stdio" },
      },
    ],
    ownership: { "claude-code": { files: [], mcpServerNames: ["custom-docs"] } },
    schemaVersion: 1,
    skills: [],
    snippets: [],
  };
  const directory = join(fixture.homeDir, "agents");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "aura.json"), `${JSON.stringify(manifest, undefined, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rewriteConfig(fixture, "v1");
}

/** The application's own churn: unrelated bookkeeping changes, the foreign server stays. */
async function rewriteConfig(fixture: Fixture, marker: string): Promise<void> {
  await writeFile(
    configPath(fixture.homeDir),
    `${JSON.stringify({ bookkeeping: marker, mcpServers: { foreign: { command: "keep-me" } } })}\n`,
    "utf8",
  );
}

async function parsedConfig(fixture: Fixture): Promise<Record<string, unknown>> {
  const raw: unknown = JSON.parse(await readFile(configPath(fixture.homeDir), "utf8"));
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Expected the MCP configuration to be an object.");
  }
  return { ...raw };
}

function configPath(homeDir: string): string {
  return join(homeDir, ".claude-code-mcp.json");
}

function plugin(): AuraPlugin {
  return definePlugin({
    adapters: [adapter()],
    apiVersion: 2,
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
    name: "Fixture MCP",
    version: "1.0.0",
  });
}

function adapter(): Adapter {
  return defineAdapter({
    detect: () => Promise.resolve({ installed: true, version: "1.0.0" }),
    displayName: "claude-code",
    files: ({ environment }) => [
      {
        id: "claude-code.mcp.global",
        kind: "mcp",
        optional: true,
        path: configPath(environment.homeDir),
        scope: "global",
      },
    ],
    id: "claude-code",
    mcpWrite: (input) =>
      writeJsonMcpServers(input, (entry) => jsonMcpEntry(entry, (name) => `\${${name}}`)),
    parse: ({ files }) => {
      const file = files.get("claude-code.mcp.global");
      const parsed =
        file === undefined
          ? { servers: [], unusable: [] }
          : parseJsonMcpServers(file, {
              appId: "claude-code",
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
