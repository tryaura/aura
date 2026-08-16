import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Finding, GuidedFixChoice, WorkspaceModel } from "@tryaura/aura-sdk";
import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";
import {
  applyFixPlan,
  hashManagedSnippet,
  parseAuraManifest,
  prepareFixPlan,
  reconcileManagedBlock,
  runChecks,
} from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { managedBlockHashCheck } from "./mgd-001.js";

const SNIPPET_ID = "official/rules";

describe("MGD-001 guided fix integration", () => {
  it("applies Keep atomically, preserves surrounding prose, and ends clean", async () => {
    await using fixture = await createFixture();
    const before = await readFile(fixture.sharedPath, "utf8");
    const choice = selectedChoice(fixture.model, "keep");
    await apply(choice, fixture);

    const after = await readFile(fixture.sharedPath, "utf8");
    const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    expect(after.startsWith("handwritten before\n")).toBe(true);
    expect(after.endsWith("handwritten after\n")).toBe(true);
    expect(after).toContain("user edit\n");
    expect(after).not.toBe(before);
    expect(manifest.snippets[0]).toMatchObject({
      hash: hashManagedSnippet("user edit"),
      pinned: true,
      version: "1.0.0",
    });
    expect(runChecks([managedBlockHashCheck], await fixture.rescan()).findings).toEqual([]);
  });

  it("applies Restore from the current registry version without touching outside the block", async () => {
    await using fixture = await createFixture();
    const choice = selectedChoice(fixture.model, "restore");
    await apply(choice, fixture);

    const after = await readFile(fixture.sharedPath, "utf8");
    const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    expect(after.startsWith("handwritten before\n")).toBe(true);
    expect(after.endsWith("handwritten after\n")).toBe(true);
    expect(after).toContain("current canonical\n<!-- aura:end id=official/rules -->");
    expect(manifest.snippets[0]).toMatchObject({
      hash: hashManagedSnippet("current canonical"),
      pinned: false,
      version: "2.0.0",
    });
  });

  it("keeps Merge manual and refuses executable fixes for malformed markers", async () => {
    await using fixture = await createFixture();
    const before = await readFile(fixture.sharedPath, "utf8");
    const merge = selectedChoice(fixture.model, "merge");

    expect(merge.plan.operations).toEqual([]);
    expect(merge.details?.()).toContain("-user edit");
    expect(JSON.stringify(merge)).not.toContain("user edit");
    expect(await readFile(fixture.sharedPath, "utf8")).toBe(before);

    await writeFile(fixture.sharedPath, "before\n<!-- aura:begin -->\nbroken\n", "utf8");
    const malformedModel = await fixture.rescan();
    const malformed = onlyFinding(malformedModel);
    const choices = managedBlockHashCheck.guidedFixes?.(malformed, malformedModel) ?? [];
    expect(choices).toHaveLength(1);
    expect(choices[0]?.id).toBe("merge");
    expect(choices[0]?.plan.operations).toEqual([]);
    expect(await readFile(fixture.sharedPath, "utf8")).toBe(
      "before\n<!-- aura:begin -->\nbroken\n",
    );
  });
});

interface Fixture extends AsyncDisposable {
  readonly manifestPath: string;
  readonly model: WorkspaceModel;
  readonly rescan: () => Promise<WorkspaceModel>;
  readonly root: string;
  readonly sharedPath: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aura-mgd-001-")));
  const homeDir = join(root, "home");
  const workspaceDir = join(root, "workspace");
  const sharedPath = join(homeDir, "agents", "AGENTS.md");
  const manifestPath = join(homeDir, "agents", "aura.json");
  await Promise.all([
    mkdir(join(homeDir, "agents"), { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
  ]);

  const source =
    reconcileManagedBlock("handwritten before\n", [{ content: "old canonical", id: SNIPPET_ID }])
      .content + "handwritten after\n";
  const edited = source.replace("old canonical\n", "user edit\n");
  const manifest = manifestText("1.0.0", hashManagedSnippet("old canonical"), false);
  await Promise.all([
    writeFile(sharedPath, edited, "utf8"),
    writeFile(manifestPath, manifest, { encoding: "utf8", mode: 0o600 }),
  ]);

  const rescan = async (): Promise<WorkspaceModel> =>
    modelFor(
      homeDir,
      workspaceDir,
      sharedPath,
      manifestPath,
      await readFile(sharedPath, "utf8"),
      await readFile(manifestPath, "utf8"),
    );
  const model = await rescan();
  return {
    manifestPath,
    model,
    rescan,
    root,
    sharedPath,
    [Symbol.asyncDispose]: () => rm(root, { force: true, recursive: true }),
  };
}

function modelFor(
  homeDir: string,
  workspaceDir: string,
  sharedPath: string,
  manifestPath: string,
  content: string,
  manifestContent: string,
): WorkspaceModel {
  return createWorkspaceModel({
    availableSnippets: [
      {
        content: "current canonical\n",
        description: "Integration fixture",
        hash: hashManagedSnippet("current canonical"),
        id: SNIPPET_ID,
        name: "Rules",
        version: "2.0.0",
      },
    ],
    apps: [
      {
        adapterId: "fixture",
        detection: { installed: true },
        displayName: "Fixture",
        instructionFiles: [],
        mcpServers: [],
        skills: [],
        sourceFiles: [
          {
            exists: true,
            pathKind: "file",
            spec: {
              id: "fixture.instructions",
              kind: "instructions",
              path: sharedPath,
              scope: "global",
            },
          },
        ],
        support: { status: "supported", supportedRange: "*" },
      },
    ],
    cwd: workspaceDir,
    homeDir,
    manifest: parseAuraManifest(manifestContent, manifestPath),
    sharedInstructions: { content, exists: true, path: sharedPath },
  });
}

async function apply(choice: GuidedFixChoice, fixture: Fixture): Promise<void> {
  const prepared = await prepareFixPlan({ model: fixture.model, plan: choice.plan });
  expect(prepared.preview.conflictedOperationCount).toBe(0);
  await applyFixPlan(prepared, { now: () => new Date(0), stateHomeDir: fixture.root });
}

function selectedChoice(model: WorkspaceModel, id: string): GuidedFixChoice {
  const finding = onlyFinding(model);
  const choice = managedBlockHashCheck
    .guidedFixes?.(finding, model)
    .find((candidate) => candidate.id === id);
  if (choice === undefined) {
    throw new Error(`expected ${id} choice`);
  }
  return choice;
}

function onlyFinding(model: WorkspaceModel): Finding {
  const finding = runChecks([managedBlockHashCheck], model).findings[0];
  if (finding === undefined) {
    throw new Error("expected MGD-001 finding");
  }
  return finding;
}

function manifestText(version: string, hash: string, pinned: boolean): string {
  return `${JSON.stringify(
    {
      apps: {},
      mcpServers: [],
      ownership: {},
      schemaVersion: 1,
      skills: [],
      snippets: [{ hash, id: SNIPPET_ID, pinned, version }],
    },
    undefined,
    2,
  )}\n`;
}
