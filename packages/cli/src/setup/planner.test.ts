import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildWorkspaceModel, createEnvironment } from "@tryaura/core";
import type { WorkspaceModel } from "@tryaura/aura-sdk";

import type { AppCatalogEntry } from "./catalog.js";
import { planSetup } from "./planner.js";
import { emptySnippetCatalog } from "./testing.js";
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
  it("plans the manifest write from the baseline selection", async () => {
    const model = await scan();
    const outcome = planSetup(context(model, true));

    expect(outcome.blockers).toEqual([]);
    expect(operationPaths(outcome)).toEqual([join(model.homeDir, "agents", "aura.json")]);
    expect(outcome.plan.operations[0]).toMatchObject({ mode: 0o600, type: "write" });
  });

  it("plans nothing when nothing was selected on a bare machine", async () => {
    const model = await scan();
    const outcome = planSetup(context(model, false));

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

    const outcome = planSetup(context(model, false));
    expect(operationPaths(outcome)).toEqual([join(model.homeDir, "agents", "aura.json")]);
  });

  it("returns a read-only manifest as a blocker instead of an operation", async () => {
    const model = await scan(async (homeDir) => {
      await mkdir(join(homeDir, "agents"), { recursive: true });
      await writeFile(join(homeDir, "agents", "aura.json"), "{ not json", "utf8");
    });

    const outcome = planSetup(context(model, true));
    expect(operationPaths(outcome)).toEqual([]);
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

    const outcome = planSetup(context(model, true));
    expect(operationPaths(outcome)).toEqual([join(model.homeDir, "agents", "aura.json")]);
    expect(outcome.blockers).toEqual([
      {
        path: model.sharedInstructions.path,
        reason: expect.stringContaining("denied"),
      },
    ]);
  });

  it("folds the app selection into the manifest and preserves extension fields", async () => {
    const model = await scan(async (homeDir) => {
      await mkdir(join(homeDir, "agents"), { recursive: true });
      await writeFile(
        join(homeDir, "agents", "aura.json"),
        `${JSON.stringify({
          apps: { kept: { managed: true, note: "extension" }, stopped: { managed: true } },
          mcpServers: [],
          ownership: {},
          schemaVersion: 1,
          skills: [],
          snippets: [],
        })}\n`,
        "utf8",
      );
    });

    const outcome = planSetup({
      appCatalog: catalog("added", "kept", "stopped"),
      manifest: model.manifest,
      model,
      selections: { apps: { managed: ["kept", "added"] } },
      snippetCatalog: emptySnippetCatalog(),
    });

    expect(outcome.manifest.apps).toEqual({
      added: { managed: true },
      kept: { managed: true, note: "extension" },
      stopped: { managed: false },
    });
    expect(operationPaths(outcome)).toEqual([join(model.homeDir, "agents", "aura.json")]);
  });

  it("creates the manifest when apps were selected even without the baseline slice", async () => {
    const model = await scan();

    const outcome = planSetup({
      appCatalog: catalog("app"),
      manifest: model.manifest,
      model,
      selections: { apps: { managed: ["app"] } },
      snippetCatalog: emptySnippetCatalog(),
    });

    expect(operationPaths(outcome)).toEqual([join(model.homeDir, "agents", "aura.json")]);
    expect(outcome.manifest.apps).toEqual({ app: { managed: true } });
  });

  it("keeps manifest apps untouched when the apps step did not run", async () => {
    const model = await scan(async (homeDir) => {
      await mkdir(join(homeDir, "agents"), { recursive: true });
      await writeFile(
        join(homeDir, "agents", "aura.json"),
        `${JSON.stringify({
          apps: { existing: { managed: true } },
          mcpServers: [],
          ownership: {},
          schemaVersion: 1,
          skills: [],
          snippets: [],
        })}\n`,
        "utf8",
      );
    });

    const outcome = planSetup(context(model, false));

    expect(outcome.manifest.apps).toEqual({ existing: { managed: true } });
    expect(outcome.plan.manualSteps).toEqual([]);
  });

  it("queues install instructions and stop-managing notes as manual steps", async () => {
    const model = await scan(async (homeDir) => {
      await mkdir(join(homeDir, "agents"), { recursive: true });
      await writeFile(
        join(homeDir, "agents", "aura.json"),
        `${JSON.stringify({
          apps: { stopped: { managed: true } },
          mcpServers: [],
          ownership: {},
          schemaVersion: 1,
          skills: [],
          snippets: [],
        })}\n`,
        "utf8",
      );
    });

    const outcome = planSetup({
      appCatalog: [
        {
          adapterId: "hinted",
          displayName: "Hinted",
          installHint: "brew install hinted",
          kind: "undetected",
        },
        { adapterId: "hintless", displayName: "Hintless", kind: "undetected" },
        { adapterId: "stopped", displayName: "Stopped", kind: "undetected" },
      ],
      manifest: model.manifest,
      model,
      selections: { apps: { managed: ["hinted", "hintless"] } },
      snippetCatalog: emptySnippetCatalog(),
    });

    expect(outcome.plan.manualSteps).toEqual([
      "Install Hinted: brew install hinted",
      "Install Hintless — its adapter provides no install instructions.",
      "Aura stops managing Stopped; its existing configuration is left in place.",
    ]);
  });

  it("reports a shared-file problem even when the wizard cannot select that file", async () => {
    const scanned = await scan();
    const model: WorkspaceModel = {
      ...scanned,
      sharedInstructions: {
        exists: true,
        path: scanned.sharedInstructions.path,
        problem: "unsupported",
      },
    };

    const outcome = planSetup(context(model, false));

    expect(outcome.plan.operations).toEqual([]);
    expect(outcome.blockers).toEqual([
      {
        path: model.sharedInstructions.path,
        reason: expect.stringContaining("unsupported"),
      },
    ]);
  });
});

function operationPaths(outcome: ReturnType<typeof planSetup>): readonly string[] {
  return outcome.plan.operations.map((operation) =>
    operation.type === "move" ? operation.destinationPath : operation.path,
  );
}

function catalog(...ids: readonly string[]): readonly AppCatalogEntry[] {
  return ids.map((id) => ({ adapterId: id, displayName: id, kind: "undetected" }));
}

function context(model: WorkspaceModel, createManifest: boolean): SetupStepContext {
  return {
    appCatalog: [],
    manifest: model.manifest,
    model,
    selections: { baseline: { createManifest } },
    snippetCatalog: emptySnippetCatalog(),
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
