import { join } from "node:path";

import {
  parseJsonMcpServers,
  writeJsonMcpServers,
  type AuraManifest,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { buildWorkspaceModel } from "./build.js";
import { planManifestMcpConvergence } from "./mcp-plan.js";
import { createMemoryReader, createTestAdapter, createTestEnvironment } from "./testing.js";

const SECRET_CONFIG = '{"private":"keep-secret","mcpServers":{"personal":{"command":"keep"}}}\n';

describe("manifest MCP convergence", () => {
  it("keeps raw source bytes out of the model and builds config plus ledger writes", async () => {
    const { configPath, manifestPath, model } = await scan({ config: SECRET_CONFIG });

    expect(JSON.stringify(model)).not.toContain("keep-secret");
    // The planner is reachable through core alone; nothing on the model hands a check the bytes.
    expect(Object.values(model.apps[0] ?? {}).some((value) => typeof value === "function")).toBe(
      false,
    );

    const convergence = planManifestMcpConvergence(model, "fake");
    expect(convergence.blockers).toEqual([]);
    expect(
      convergence.plan?.operations.map((operation) =>
        operation.type === "write" ? operation.path : "",
      ),
    ).toEqual([configPath, manifestPath]);
  });

  it("declares the bytes it read so a later edit becomes a conflict rather than a revert", async () => {
    const { model } = await scan({ config: SECRET_CONFIG });
    const write = planManifestMcpConvergence(model, "fake").plan?.operations[0];

    expect(write?.type === "write" ? write.precondition : undefined).toEqual({
      digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      kind: "sha256",
    });
  });

  it("refuses a differing same-name server outside the ownership ledger", async () => {
    const { model } = await scan({
      config: '{"mcpServers":{"managed":{"command":"user-command"}}}\n',
    });

    expect(planManifestMcpConvergence(model, "fake")).toMatchObject({
      blockers: [expect.objectContaining({ message: expect.stringContaining("ownership ledger") })],
    });
  });

  it("reports a desired name the application declares but will not run", async () => {
    const { model } = await scan({
      config: '{"mcpServers":{"managed":{"command":"manifest-command","enabled":false}}}\n',
    });

    expect(planManifestMcpConvergence(model, "fake")).toMatchObject({
      blockers: [expect.objectContaining({ message: expect.stringContaining("turned off") })],
    });
  });

  it("leaves an unmanaged application alone rather than undoing what it owns", async () => {
    const { model } = await scan({
      config: '{"mcpServers":{"managed":{"command":"manifest-command"}}}\n',
      managed: false,
      ownership: ["managed"],
    });

    expect(planManifestMcpConvergence(model, "fake")).toEqual({ blockers: [] });
  });

  it("does not collide a same-name server configured in another scope", async () => {
    const { model } = await scan({
      config: "{}\n",
      project: '{"mcpServers":{"managed":{"command":"unrelated"}}}\n',
    });

    expect(planManifestMcpConvergence(model, "fake").blockers).toEqual([]);
  });
});

interface ScanOptions {
  readonly config: string;
  readonly managed?: boolean;
  readonly ownership?: readonly string[];
  readonly project?: string;
}

async function scan(options: ScanOptions): Promise<{
  readonly configPath: string;
  readonly manifestPath: string;
  readonly model: WorkspaceModel;
}> {
  const environment = createTestEnvironment();
  const configPath = join(environment.homeDir, ".fake", "mcp.json");
  const projectPath = join(environment.cwd, ".fake.json");
  const manifestPath = join(environment.homeDir, "agents", "aura.json");
  const built = await buildWorkspaceModel({
    adapters: [fakeAdapter(configPath, projectPath)],
    environment,
    reader: createMemoryReader({
      [configPath]: options.config,
      [manifestPath]: JSON.stringify(manifest(options.ownership ?? [], options.managed ?? true)),
      ...(options.project === undefined ? {} : { [projectPath]: options.project }),
    }),
  });
  return { configPath, manifestPath, model: built.model };
}

function fakeAdapter(configPath: string, projectPath: string) {
  return createTestAdapter({
    files: () => [
      { id: "fake.mcp.global", kind: "mcp", path: configPath, scope: "global" },
      { id: "fake.mcp.project", kind: "mcp", optional: true, path: projectPath, scope: "project" },
    ],
    id: "fake",
    mcpWrite: (input) =>
      writeJsonMcpServers(input, (entry) =>
        entry.transport.type === "stdio"
          ? { command: entry.transport.command }
          : { type: "http", url: entry.transport.url },
      ),
    parse: ({ files }) => {
      const parsed = ["fake.mcp.global", "fake.mcp.project"].map((id) => {
        const file = files.get(id);
        return file === undefined
          ? { servers: [], unusable: [] }
          : parseJsonMcpServers(file, {
              appId: "fake",
              variablePattern: /\$\{([A-Z_][A-Z0-9_]*)\}/gu,
            });
      });
      return {
        instructionFiles: [],
        mcpServers: parsed.flatMap((entry) => entry.servers),
        skills: [],
        unusableMcpServers: parsed.flatMap((entry) => entry.unusable),
      };
    },
  });
}

function manifest(mcpServerNames: readonly string[], managed: boolean): AuraManifest {
  return {
    apps: { fake: { managed } },
    mcpServers: [
      {
        apps: ["fake"],
        name: "managed",
        scope: "global",
        transport: { command: "manifest-command", type: "stdio" },
      },
    ],
    ownership: { fake: { files: [], mcpServerNames } },
    schemaVersion: 1,
    skills: [],
    snippets: [],
  };
}
