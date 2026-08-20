import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  parseJsonMcpServers,
  writeJsonMcpServers,
  type AuraManifest,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { buildWorkspaceModel } from "./build.js";
import { planDesiredMcpConvergence, planManifestMcpConvergence } from "./mcp-plan.js";
import { refreshMcpSources } from "./mcp-refresh.js";
import { createMemoryReader, createTestAdapter, createTestEnvironment } from "./testing.js";

const V1_CONFIG = '{"private":"v1-only","mcpServers":{"personal":{"command":"keep"}}}\n';
const V2_CONFIG = '{"private":"v2-only","mcpServers":{"personal":{"command":"keep"}}}\n';

describe("refreshMcpSources", () => {
  it("re-plans against refreshed bytes, moving the precondition off the scanned file", async () => {
    const { configPath, model, plan } = await scan({ config: V1_CONFIG });
    expect(preconditionDigest(plan(model))).toBe(sha256(V1_CONFIG));

    await refreshMcpSources(model, createMemoryReader({ [configPath]: V2_CONFIG }));

    const write = plan(model);
    expect(preconditionDigest(write)).toBe(sha256(V2_CONFIG));
    // The rewrite merges into the refreshed bytes, so an edit made mid-wizard survives the apply.
    expect(write?.type === "write" ? write.content : "").toContain("v2-only");
  });

  it("forgets memoized manifest plans built from the bytes a refresh replaced", async () => {
    const { configPath, model } = await scan({ config: V1_CONFIG });
    const before = planManifestMcpConvergence(model, "fake").plan?.operations[0];
    expect(preconditionDigest(before)).toBe(sha256(V1_CONFIG));

    await refreshMcpSources(model, createMemoryReader({ [configPath]: V2_CONFIG }));

    const after = planManifestMcpConvergence(model, "fake").plan?.operations[0];
    expect(preconditionDigest(after)).toBe(sha256(V2_CONFIG));
  });

  it("re-reads only MCP configuration paths, not the rest of the scanned files", async () => {
    const { configPath, model, projectPath } = await scan({ config: V1_CONFIG });
    const reader = createMemoryReader({ [configPath]: V2_CONFIG });

    await refreshMcpSources(model, reader);

    expect([...new Set(reader.reads)].sort()).toEqual([projectPath, configPath].sort());
  });

  it("turns a refresh that cannot read the file into a blocker instead of a stale write", async () => {
    const { configPath, model } = await scan({ config: V1_CONFIG });

    await refreshMcpSources(
      model,
      createMemoryReader({}, { problems: { [configPath]: "unreadable" } }),
    );

    expect(planManifestMcpConvergence(model, "fake")).toMatchObject({
      blockers: [
        expect.objectContaining({ message: expect.stringContaining("could not be read safely") }),
      ],
    });
  });

  it("flips an absent-file precondition to a digest when the file appears mid-run", async () => {
    const { configPath, model, plan } = await scan({ config: undefined });
    const before = plan(model);
    expect(before?.type === "write" ? before.precondition : undefined).toEqual({ kind: "absent" });

    await refreshMcpSources(model, createMemoryReader({ [configPath]: V2_CONFIG }));

    expect(preconditionDigest(plan(model))).toBe(sha256(V2_CONFIG));
  });

  it("is a no-op for a model whose apps registered no refresher", async () => {
    const environment = createTestEnvironment();
    const built = await buildWorkspaceModel({
      adapters: [],
      environment,
      reader: createMemoryReader({}),
    });

    await expect(refreshMcpSources(built.model, createMemoryReader({}))).resolves.toBeUndefined();
  });
});

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function preconditionDigest(operation: { type: string } | undefined): string | undefined {
  return operation !== undefined &&
    "precondition" in operation &&
    typeof operation.precondition === "object" &&
    operation.precondition !== null &&
    "digest" in operation.precondition &&
    typeof operation.precondition.digest === "string"
    ? operation.precondition.digest
    : undefined;
}

async function scan(options: { readonly config: string | undefined }): Promise<{
  readonly configPath: string;
  readonly model: WorkspaceModel;
  readonly plan: (model: WorkspaceModel) => ReturnType<typeof firstOperation>;
  readonly projectPath: string;
}> {
  const environment = createTestEnvironment();
  const configPath = join(environment.homeDir, ".fake", "mcp.json");
  const projectPath = join(environment.cwd, ".fake.json");
  const manifestPath = join(environment.homeDir, "agents", "aura.json");
  const built = await buildWorkspaceModel({
    adapters: [fakeAdapter(configPath, projectPath, join(environment.homeDir, "FAKE.md"))],
    environment,
    reader: createMemoryReader({
      ...(options.config === undefined ? {} : { [configPath]: options.config }),
      [join(environment.homeDir, "FAKE.md")]: "# instructions\n",
      [manifestPath]: JSON.stringify(manifest()),
    }),
  });
  return {
    configPath,
    model: built.model,
    plan: (model) => firstOperation(model),
    projectPath,
  };
}

function firstOperation(model: WorkspaceModel) {
  if (model.manifest.status !== "ready") {
    throw new Error("Expected a ready manifest fixture.");
  }
  return planDesiredMcpConvergence(model, model.manifest.value, "fake").operations[0];
}

function fakeAdapter(configPath: string, projectPath: string, instructionsPath: string) {
  return createTestAdapter({
    files: () => [
      { id: "fake.mcp.global", kind: "mcp", optional: true, path: configPath, scope: "global" },
      { id: "fake.mcp.project", kind: "mcp", optional: true, path: projectPath, scope: "project" },
      {
        id: "fake.instructions",
        kind: "instructions",
        optional: true,
        path: instructionsPath,
        scope: "global",
      },
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

function manifest(): AuraManifest {
  return {
    apps: { fake: { managed: true } },
    mcpServers: [
      {
        apps: ["fake"],
        name: "managed",
        scope: "global",
        transport: { command: "manifest-command", type: "stdio" },
      },
    ],
    ownership: { fake: { files: [], mcpServerNames: ["managed"] } },
    schemaVersion: 1,
    skills: [],
    snippets: [],
  };
}
