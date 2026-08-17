/* eslint-disable max-lines -- the MGD-001 detection and guided-choice matrix shares model fixtures. */
import type { AppModel, Finding, WorkspaceModel } from "@tryaura/aura-sdk";
import {
  hashManagedSnippet,
  parseAuraManifest,
  readManagedBlock,
  reconcileManagedBlock,
  reconcileManagedSnippet,
  runChecks,
} from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { app, document, model } from "./testing.js";
import { managedBlockHashCheck } from "./mgd-001.js";

const PATH = "/home/dev/agents/AGENTS.md";
const SNIPPET_ID = "official/rules";

describe("MGD-001", () => {
  it("reports one stable finding per changed snippet without exposing its body", () => {
    const source = managedSource([
      { content: "first", id: "official/first" },
      { content: "second", id: "official/second" },
    ])
      .replace("first\n", "private first edit\n")
      .replace("second\n", "private second edit\n");
    const workspace = withShared(model(), source);

    const findings = runChecks([managedBlockHashCheck], workspace).findings;

    expect(findings.map((finding) => finding.id)).toEqual([
      "aura.shared-instructions:official/first",
      "aura.shared-instructions:official/second",
    ]);
    expect(findings.map((finding) => finding.locations?.[0]?.line)).toEqual([4, 7]);
    expect(JSON.stringify(findings)).not.toContain("private first edit");
    expect(JSON.stringify(findings)).not.toContain("private second edit");
  });

  it("reports an edit whose marker hash was re-stamped against the manifest anchor", () => {
    const edited = managedSource([{ content: "old canonical", id: SNIPPET_ID }]).replace(
      "old canonical\n",
      "re-stamped edit\n",
    );
    const restamped = reconcileManagedSnippet(edited, SNIPPET_ID, { kind: "keep" });
    const workspace = managedWorkspace(restamped.content);

    const finding = onlyFinding(workspace);

    expect(readManagedBlock(restamped.content)).toMatchObject({
      block: { snippets: [expect.objectContaining({ hashMatches: true })] },
      status: "present",
    });
    expect(finding.id).toBe(`aura.shared-instructions:${SNIPPET_ID}`);
  });

  it("reports an unterminated fence that hides a managed block", () => {
    const source = `# Doc\n\`\`\`\n${managedSource([{ content: "canonical", id: SNIPPET_ID }])}`;
    const workspace = managedWorkspace(source);
    const finding = onlyFinding(workspace);
    const choices = managedBlockHashCheck.guidedFixes?.(finding, workspace) ?? [];

    expect(finding).toMatchObject({
      id: "aura.shared-instructions:unterminated-fence",
      metadata: { kind: "unterminated-fence" },
    });
    expect(choices).toEqual([
      expect.objectContaining({
        id: "close-fence",
        plan: expect.objectContaining({ operations: [] }),
      }),
    ]);
  });

  it("reports one stable malformed finding and offers no executable resolution", () => {
    const workspace = withShared(model(), "before\n<!-- aura:begin -->\nbroken\n");
    const finding = onlyFinding(workspace);
    const choices = managedBlockHashCheck.guidedFixes?.(finding, workspace) ?? [];

    expect(finding.id).toBe("aura.shared-instructions:malformed-managed-block");
    expect(finding.metadata?.["problems"]).toEqual([{ code: "incomplete-outer-block", line: 2 }]);
    expect(choices).toEqual([
      expect.objectContaining({
        id: "merge",
        plan: expect.objectContaining({ operations: [] }),
      }),
    ]);
  });

  it("keeps the edit, pins an unambiguous manifest selection, and becomes clean", () => {
    const edited = managedSource([{ content: "canonical", id: SNIPPET_ID }]).replace(
      "canonical\n",
      "kept edit\n",
    );
    const workspace = managedWorkspace(edited);
    const finding = onlyFinding(workspace);
    const choice = choiceById(finding, workspace, "keep");
    const fileWrite = choice.plan.operations[0];
    const manifestWrite = choice.plan.operations[1];

    expect(fileWrite).toMatchObject({ path: PATH, type: "write" });
    expect(manifestWrite).toMatchObject({ path: "/home/dev/agents/aura.json", type: "write" });
    if (fileWrite?.type !== "write" || manifestWrite?.type !== "write") {
      throw new Error("expected file and manifest writes");
    }
    const parsed = readManagedBlock(fileWrite.content);
    expect(parsed.status).toBe("present");
    if (parsed.status !== "present") {
      throw new Error("expected a managed block");
    }
    expect(parsed.block.snippets[0]).toMatchObject({
      content: "kept edit\n",
      hashMatches: true,
    });
    expect(JSON.parse(manifestWrite.content).snippets[0]).toMatchObject({
      hash: hashManagedSnippet("kept edit"),
      pinned: true,
      version: "1.0.0",
    });
    const rescanned = {
      ...withShared(workspace, fileWrite.content),
      manifest: parseAuraManifest(manifestWrite.content, manifestWrite.path),
    };
    expect(runChecks([managedBlockHashCheck], rescanned).findings).toEqual([]);
  });

  it("restores the registry's current content and advances the manifest selection", () => {
    const edited = managedSource([{ content: "old canonical", id: SNIPPET_ID }]).replace(
      "old canonical\n",
      "hand edit\n",
    );
    const workspace = managedWorkspace(edited);
    const finding = onlyFinding(workspace);
    const choice = choiceById(finding, workspace, "restore");
    const fileWrite = choice.plan.operations[0];
    const manifestWrite = choice.plan.operations[1];

    if (fileWrite?.type !== "write" || manifestWrite?.type !== "write") {
      throw new Error("expected file and manifest writes");
    }
    expect(fileWrite.content).toContain("current canonical\n<!-- aura:end id=official/rules -->");
    expect(JSON.parse(manifestWrite.content).snippets[0]).toMatchObject({
      hash: hashManagedSnippet("current canonical"),
      pinned: false,
      version: "2.0.0",
    });
  });

  it("offers manual merge detail and does not write", () => {
    const edited = managedSource([{ content: "canonical", id: SNIPPET_ID }]).replace(
      "canonical\n",
      "hand edit\n",
    );
    const workspace = managedWorkspace(edited);
    const choice = choiceById(onlyFinding(workspace), workspace, "merge");

    expect(choice.details?.()).toContain("-hand edit");
    expect(choice.details?.()).toContain("+current canonical");
    // The diff quotes the user's file, so it must not be reachable by serializing the choice.
    expect(JSON.stringify(choice)).not.toContain("hand edit");
    expect(choice.plan.operations).toEqual([]);
    expect(choice.plan.manualSteps?.[0]).toContain(`${PATH} at lines 4-6`);
  });

  it("normalizes CRLF on both sides of the manual merge diff", () => {
    const edited = managedSource([{ content: "canonical", id: SNIPPET_ID }])
      .replace("canonical\n", "hand edit\n")
      .replaceAll("\n", "\r\n");
    const workspace = managedWorkspace(edited);
    const choice = choiceById(onlyFinding(workspace), workspace, "merge");

    expect(choice.details?.()).not.toContain("\r");
    expect(choice.details?.()).toContain("-hand edit");
    expect(choice.details?.()).toContain("+current canonical");
  });

  it("says so when it can write the file but not the manifest entry", () => {
    const edited = managedSource([{ content: "canonical", id: SNIPPET_ID }]).replace(
      "canonical\n",
      "kept edit\n",
    );
    const ambiguous = managedWorkspace(edited, [
      {
        hash: hashManagedSnippet("old canonical"),
        id: SNIPPET_ID,
        pinned: false,
        version: "1.0.0",
      },
      { hash: hashManagedSnippet("other"), id: SNIPPET_ID, pinned: true, version: "1.1.0" },
    ]);
    const choice = choiceById(onlyFinding(ambiguous), ambiguous, "keep");

    expect(choice.plan.operations).toHaveLength(1);
    expect(choice.plan.manualSteps?.[0]).toContain("2 manifest entries claim that id");
    expect(choice.plan.manualSteps?.[0]).toContain(hashManagedSnippet("kept edit"));
  });

  it("omits restore when the registry cannot resolve the snippet", () => {
    const edited = managedSource([{ content: "canonical", id: SNIPPET_ID }]).replace(
      "canonical\n",
      "hand edit\n",
    );
    const workspace = withShared(model(), edited);
    const finding = onlyFinding(workspace);
    const choices = managedBlockHashCheck.guidedFixes?.(finding, workspace) ?? [];

    expect(choices.map((choice) => choice.id)).toEqual(["keep", "merge"]);
    expect(choices[0]?.plan.manualSteps?.[0]).toContain("Create /home/dev/agents/aura.json");
    expect(choices[1]?.details).toBeUndefined();
  });

  it("throws when a detected mismatch can no longer build its resolution context", () => {
    const workspace = model();
    const stale: Finding = {
      checkId: "MGD-001",
      id: "stale",
      message: "Stale finding.",
      metadata: {
        kind: "hash-mismatch",
        snippetId: "missing/snippet",
        sourceId: "aura.shared-instructions",
      },
      scope: "global",
      severity: "warn",
    };

    expect(() => managedBlockHashCheck.guidedFixes?.(stale, workspace)).toThrow(
      "is no longer available",
    );
  });

  it("skips symlink instruction entries and deduplicates regular paths", () => {
    const edited = managedSource([{ content: "canonical", id: SNIPPET_ID }]).replace(
      "canonical\n",
      "hand edit\n",
    );
    const linkedDocument = {
      ...document("/home/dev/.codex/AGENTS.md", edited),
      sourceId: "codex.instructions.global",
    };
    const linkedApp: AppModel = {
      ...app({
        adapterId: "codex",
        sources: [
          {
            exists: true,
            pathKind: "symlink",
            spec: {
              id: linkedDocument.sourceId,
              kind: "instructions",
              path: linkedDocument.path,
              scope: "global",
            },
          },
        ],
      }),
      instructionFiles: [linkedDocument],
    };
    const regular = document("/repo/AGENTS.md", edited);
    const workspace = model({
      apps: [linkedApp],
      instructionFiles: [regular, { ...regular, sourceId: "duplicate" }],
    });

    const findings = runChecks([managedBlockHashCheck], workspace).findings;

    expect(findings).toHaveLength(1);
    expect(findings[0]?.locations?.[0]?.path).toBe("/repo/AGENTS.md");
  });
});

function managedSource(
  snippets: readonly { readonly content: string; readonly id: string }[],
): string {
  return reconcileManagedBlock("before\n", snippets).content + "after\n";
}

function withShared(workspace: WorkspaceModel, content: string): WorkspaceModel {
  return {
    ...workspace,
    sharedInstructions: { content, exists: true, path: PATH },
  };
}

function managedWorkspace(content: string, snippets?: readonly object[]): WorkspaceModel {
  const manifest = parseAuraManifest(
    JSON.stringify({
      apps: {},
      mcpServers: [],
      ownership: {},
      schemaVersion: 1,
      skills: [],
      snippets: snippets ?? [
        {
          hash: hashManagedSnippet("old canonical"),
          id: SNIPPET_ID,
          pinned: false,
          version: "1.0.0",
        },
      ],
    }),
    "/home/dev/agents/aura.json",
  );
  return {
    ...withShared(model(), content),
    availableSnippets: [
      {
        content: "current canonical\n",
        description: "Current fixture",
        hash: hashManagedSnippet("current canonical"),
        id: SNIPPET_ID,
        name: "Rules",
        version: "2.0.0",
      },
    ],
    manifest,
  };
}

function onlyFinding(workspace: WorkspaceModel): Finding {
  const finding = runChecks([managedBlockHashCheck], workspace).findings[0];
  if (finding === undefined) {
    throw new Error("expected MGD-001 finding");
  }
  return finding;
}

function choiceById(finding: Finding, workspace: WorkspaceModel, id: string) {
  const choice = managedBlockHashCheck
    .guidedFixes?.(finding, workspace)
    .find((candidate) => candidate.id === id);
  if (choice === undefined) {
    throw new Error(`expected ${id} choice`);
  }
  return choice;
}
