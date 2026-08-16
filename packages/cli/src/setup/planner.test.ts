import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildWorkspaceModel, createEnvironment } from "@tryaura/core";
import type { WorkspaceModel } from "@tryaura/aura-sdk";

import { planSetup } from "./planner.js";
import type { SetupStepContext } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("planSetup", () => {
  it("plans the manifest write first, then the shared instructions", async () => {
    const model = await scan();
    const outcome = planSetup(context(model, true, true));

    expect(outcome.blockers).toEqual([]);
    expect(operationPaths(outcome)).toEqual([
      join(model.homeDir, "agents", "aura.json"),
      join(model.homeDir, "agents", "AGENTS.md"),
    ]);
    expect(outcome.plan.operations[0]).toMatchObject({ mode: 0o600, type: "write" });
  });

  it("plans nothing when nothing was selected on a bare machine", async () => {
    const model = await scan();
    const outcome = planSetup(context(model, false, false));

    expect(outcome.plan.operations).toEqual([]);
    expect(outcome.blockers).toEqual([]);
  });

  it("always rewrites an existing manifest so state converges", async () => {
    const model = await scan(async (homeDir) => {
      await mkdir(join(homeDir, "agents"), { recursive: true });
      await writeFile(
        join(homeDir, "agents", "aura.json"),
        `${JSON.stringify({
          apps: {},
          mcpServers: [],
          ownership: {},
          schemaVersion: 1,
          skills: [],
          snippets: [],
        })}\n`,
        "utf8",
      );
    });

    const outcome = planSetup(context(model, false, false));
    expect(operationPaths(outcome)).toEqual([join(model.homeDir, "agents", "aura.json")]);
  });

  it("returns a read-only manifest as a blocker instead of an operation", async () => {
    const model = await scan(async (homeDir) => {
      await mkdir(join(homeDir, "agents"), { recursive: true });
      await writeFile(join(homeDir, "agents", "aura.json"), "{ not json", "utf8");
    });

    const outcome = planSetup(context(model, true, true));
    expect(operationPaths(outcome)).toEqual([join(model.homeDir, "agents", "AGENTS.md")]);
    expect(outcome.blockers).toEqual([
      {
        path: join(model.homeDir, "agents", "aura.json"),
        reason: expect.stringContaining("not valid JSON"),
      },
    ]);
  });

  it("refuses to plan over a shared file whose read had a problem", async () => {
    const scanned = await scan();
    const model: WorkspaceModel = {
      ...scanned,
      sharedInstructions: {
        exists: true,
        path: scanned.sharedInstructions.path,
        problem: "denied",
      },
    };

    const outcome = planSetup(context(model, true, true));
    expect(operationPaths(outcome)).toEqual([join(model.homeDir, "agents", "aura.json")]);
    expect(outcome.blockers).toEqual([
      {
        path: model.sharedInstructions.path,
        reason: expect.stringContaining("denied"),
      },
    ]);
  });
});

function operationPaths(outcome: ReturnType<typeof planSetup>): readonly string[] {
  return outcome.plan.operations.map((operation) =>
    operation.type === "move" ? operation.destinationPath : operation.path,
  );
}

function context(
  model: WorkspaceModel,
  createManifest: boolean,
  createSharedInstructions: boolean,
): SetupStepContext {
  return {
    manifest: model.manifest,
    model,
    selections: { baseline: { createManifest, createSharedInstructions } },
  };
}

async function scan(seed?: (homeDir: string) => Promise<void>): Promise<WorkspaceModel> {
  const root = await mkdtemp(join(tmpdir(), "aura-setup-planner-"));
  temporaryDirectories.push(root);
  const homeDir = join(root, "home");
  const workspace = join(root, "workspace");
  await mkdir(homeDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await seed?.(homeDir);

  const environment = createEnvironment({
    cwd: workspace,
    environmentVariables: {},
    homeDir,
  });
  return (await buildWorkspaceModel({ adapters: [], environment })).model;
}
