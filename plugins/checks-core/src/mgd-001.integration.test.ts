/* eslint-disable max-lines -- end-to-end guided fixes share one real-filesystem fixture. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Finding, GuidedFixChoice, WorkspaceModel } from "@tryaura/aura-sdk";
import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";
import {
  applyFixPlan,
  hashManagedSnippet,
  parseAuraManifest,
  prepareFixCandidates,
  prepareFixPlan,
  reconcileManagedBlock,
  runChecks,
} from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { managedBlockHashCheck } from "./mgd-001.js";
import { document } from "./testing.js";

const SNIPPET_ID = "official/rules";
const SECOND_SNIPPET_ID = "official/second";

interface FixtureSnippet {
  readonly current: string;
  readonly edited: string;
  readonly id: string;
  readonly old: string;
}

const DEFAULT_SNIPPETS: readonly FixtureSnippet[] = [
  { current: "current canonical", edited: "user edit", id: SNIPPET_ID, old: "old canonical" },
];

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

  it("coalesces two guided resolutions in one document and shared manifest", async () => {
    await using fixture = await createFixture([
      ...DEFAULT_SNIPPETS,
      {
        current: "second current",
        edited: "second user edit",
        id: SECOND_SNIPPET_ID,
        old: "second old",
      },
    ]);
    const findings = runChecks([managedBlockHashCheck], fixture.model).findings;
    const candidates = findings.map((finding, index) => ({
      checkId: managedBlockHashCheck.id,
      findingId: finding.id,
      plan: choiceForFinding(finding, fixture.model, index === 0 ? "keep" : "restore").plan,
    }));

    const prepared = await prepareFixCandidates({ candidates, model: fixture.model });

    expect(prepared.prepared?.preview.operations).toHaveLength(2);
    expect(prepared.operationPreviewIndexes).toEqual([
      [0, 1],
      [0, 1],
    ]);
    if (prepared.prepared === undefined) {
      throw new Error("expected a prepared fix plan");
    }
    await applyFixPlan(prepared.prepared, { now: () => new Date(0), stateHomeDir: fixture.root });

    const content = await readFile(fixture.sharedPath, "utf8");
    const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    expect(content).toContain("user edit\n");
    expect(content).toContain("second current\n");
    expect(manifest.snippets).toEqual([
      expect.objectContaining({ id: SNIPPET_ID, pinned: true }),
      expect.objectContaining({ id: SECOND_SNIPPET_ID, pinned: false }),
    ]);
  });

  it("coalesces the shared manifest when guided fixes target different documents", async () => {
    await using fixture = await createFixture();
    const secondPath = join(fixture.root, "workspace", "SECOND.md");
    const secondSource = reconcileManagedBlock("second before\n", [
      { content: "second old", id: SECOND_SNIPPET_ID },
    ]).content.replace("second old\n", "second user edit\n");
    await writeFile(secondPath, secondSource, "utf8");
    const manifestSource = manifestText([
      ...DEFAULT_SNIPPETS,
      {
        current: "second current",
        edited: "second user edit",
        id: SECOND_SNIPPET_ID,
        old: "second old",
      },
    ]);
    await writeFile(fixture.manifestPath, manifestSource, "utf8");
    const model: WorkspaceModel = {
      ...fixture.model,
      availableSnippets: [
        ...fixture.model.availableSnippets,
        {
          content: "second current\n",
          description: "Second integration fixture",
          hash: hashManagedSnippet("second current"),
          id: SECOND_SNIPPET_ID,
          name: "Second rules",
          version: "2.0.0",
        },
      ],
      instructionFiles: [document(secondPath, secondSource)],
      manifest: parseAuraManifest(manifestSource, fixture.manifestPath),
    };
    const findings = runChecks([managedBlockHashCheck], model).findings;
    const candidates = findings.map((finding) => ({
      checkId: managedBlockHashCheck.id,
      findingId: finding.id,
      plan: choiceForFinding(finding, model, "keep").plan,
    }));

    const prepared = await prepareFixCandidates({ candidates, model });

    expect(prepared.prepared?.preview.operations).toHaveLength(3);
    expect(prepared.operationPreviewIndexes).toEqual([
      [0, 1],
      [2, 1],
    ]);
    if (prepared.prepared === undefined) {
      throw new Error("expected a prepared fix plan");
    }
    await applyFixPlan(prepared.prepared, { now: () => new Date(0), stateHomeDir: fixture.root });
    const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    expect(manifest.snippets).toEqual([
      expect.objectContaining({ id: SNIPPET_ID, pinned: true }),
      expect.objectContaining({ id: SECOND_SNIPPET_ID, pinned: true }),
    ]);
  });
});

interface Fixture extends AsyncDisposable {
  readonly manifestPath: string;
  readonly model: WorkspaceModel;
  readonly rescan: () => Promise<WorkspaceModel>;
  readonly root: string;
  readonly sharedPath: string;
}

async function createFixture(
  snippets: readonly FixtureSnippet[] = DEFAULT_SNIPPETS,
): Promise<Fixture> {
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
    reconcileManagedBlock(
      "handwritten before\n",
      snippets.map((snippet) => ({ content: snippet.old, id: snippet.id })),
    ).content + "handwritten after\n";
  const edited = snippets.reduce(
    (content, snippet) => content.replace(`${snippet.old}\n`, `${snippet.edited}\n`),
    source,
  );
  const manifest = manifestText(snippets);
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
      snippets,
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
  snippets: readonly FixtureSnippet[],
): WorkspaceModel {
  return createWorkspaceModel({
    availableSnippets: snippets.map((snippet) => ({
      content: `${snippet.current}\n`,
      description: "Integration fixture",
      hash: hashManagedSnippet(snippet.current),
      id: snippet.id,
      name: "Rules",
      version: "2.0.0",
    })),
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
  return choiceForFinding(finding, model, id);
}

function choiceForFinding(finding: Finding, model: WorkspaceModel, id: string): GuidedFixChoice {
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

function manifestText(snippets: readonly FixtureSnippet[]): string {
  return `${JSON.stringify(
    {
      apps: {},
      mcpServers: [],
      ownership: {},
      schemaVersion: 1,
      skills: [],
      snippets: snippets.map((snippet) => ({
        hash: hashManagedSnippet(snippet.old),
        id: snippet.id,
        pinned: false,
        version: "1.0.0",
      })),
    },
    undefined,
    2,
  )}\n`;
}
