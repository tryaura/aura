import type { AuraManifest, WorkspaceModel } from "@tryaura/aura-sdk";
import { hashManagedSnippet, reconcileManagedBlock, runChecks } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { managedContentUpdateCheck } from "./mgd-002.js";
import { model, SHARED_PATH } from "./testing.js";

const SNIPPET_ID = "official/rules";
const OLD_HASH = hashManagedSnippet("old canonical");

describe("MGD-002", () => {
  it("reports newer and same-version changed snippets", () => {
    const newer = workspace({ availableVersion: "2.0.0" });
    const changed = workspace({ availableContent: "republished", availableVersion: "1.0.0" });

    expect(onlyFinding(newer).message).toContain("1.0.0 to 2.0.0");
    expect(onlyFinding(changed).message).toContain("1.0.0 to 1.0.0");
  });

  it("silences pinned selections", () => {
    expect(runChecks([managedContentUpdateCheck], workspace({ pinned: true })).findings).toEqual(
      [],
    );
  });

  it("reports a lower source version as diverged rather than holding it silently", () => {
    // The planner keeps the recorded revision either way, so a rollback that reported nothing
    // would leave the snippet frozen with nothing on screen naming it.
    const finding = onlyFinding(workspace({ availableVersion: "0.9.0" }));

    expect(finding.metadata?.["kind"]).toBe("snippet-diverged");
    expect(finding.message).toContain("offers 0.9.0, which is not newer");
  });

  it("offers the diverged revision as a deliberate switch", () => {
    const current = workspace({ availableVersion: "0.9.0" });
    const choice = managedContentUpdateCheck.guidedFixes?.(onlyFinding(current), current)[0];

    expect(choice?.label).toBe("Switch to 0.9.0");
    expect(choice?.plan.operations).toHaveLength(2);
  });

  it("updates a clean snippet through the managed reconciler and manifest", () => {
    const current = workspace({ availableVersion: "2.0.0" });
    const finding = onlyFinding(current);
    const choice = managedContentUpdateCheck.guidedFixes?.(finding, current)[0];

    expect(choice?.id).toBe("update");
    expect(choice?.details?.()).toContain("+new canonical");
    expect(choice?.plan.operations).toHaveLength(2);
    const manifestWrite = choice?.plan.operations[1];
    expect(
      manifestWrite?.type === "write" ? JSON.parse(manifestWrite.content).snippets[0] : undefined,
    ).toMatchObject({ pinned: false, version: "2.0.0" });
  });

  it("requires MGD-001 resolution before updating a locally edited snippet", () => {
    const current = workspace({ availableVersion: "2.0.0", installedContent: "hand edit" });
    const finding = onlyFinding(current);
    const choice = managedContentUpdateCheck.guidedFixes?.(finding, current)[0];

    expect(choice).toMatchObject({ id: "resolve-drift", plan: { operations: [] } });
  });

  it("offers pin and remove when a snippet vanished", () => {
    const current = workspace({ missing: true });
    const finding = onlyFinding(current);
    const choices = managedContentUpdateCheck.guidedFixes?.(finding, current) ?? [];

    expect(choices.map((choice) => choice.id)).toEqual(["pin", "remove"]);
    expect(choices[1]?.plan.operations).toHaveLength(2);
  });

  it("reports and plans a clean bundled skill update", () => {
    const base = workspace({ missing: true });
    const skillWorkspace: WorkspaceModel = {
      ...base,
      availableSkills: [
        {
          description: "Current skill.",
          files: [{ content: "---\nname: review\ndescription: Review.\n---\n", path: "SKILL.md" }],
          id: "review",
          name: "Review",
          source: { id: "plugin:official", kind: "bundled", name: "Official" },
          treeHash: "b".repeat(64),
          version: "2.0.0",
        },
      ],
      manifest: readyManifest({
        skills: [
          {
            id: "review",
            pinned: false,
            source: "plugin:official",
            treeHash: "a".repeat(64),
            version: "1.0.0",
          },
        ],
        snippets: [],
      }),
      sharedSkills: [
        {
          definitionStatus: "ready",
          entries: [
            { kind: "directory", path: "/home/dev/agents/skills/review" },
            { kind: "file", path: "/home/dev/agents/skills/review/SKILL.md" },
          ],
          id: "review",
          path: "/home/dev/agents/skills/review",
          treeHash: "a".repeat(64),
        },
      ],
    };

    const finding = onlyFinding(skillWorkspace);
    const choice = managedContentUpdateCheck.guidedFixes?.(finding, skillWorkspace)[0];

    expect(finding.message).toContain("1.0.0 to 2.0.0");
    expect(choice?.id).toBe("update");
    expect(choice?.plan.operations.at(-1)).toMatchObject({ path: "/home/dev/agents/aura.json" });
  });
});

function workspace(options: {
  readonly availableContent?: string;
  readonly availableVersion?: string;
  readonly installedContent?: string;
  readonly missing?: boolean;
  readonly pinned?: boolean;
}): WorkspaceModel {
  const installedContent = options.installedContent ?? "old canonical";
  const source = reconcileManagedBlock("before\n", [
    { content: installedContent, id: SNIPPET_ID },
  ]).content;
  return {
    ...model({
      manifest: readyManifest({
        snippets: [
          {
            hash: OLD_HASH,
            id: SNIPPET_ID,
            pinned: options.pinned ?? false,
            version: "1.0.0",
          },
        ],
      }),
      sharedInstructions: { content: source, exists: true },
    }),
    availableSnippets:
      options.missing === true
        ? []
        : [
            {
              content: `${options.availableContent ?? "new canonical"}\n`,
              description: "Current rules.",
              hash: hashManagedSnippet(options.availableContent ?? "new canonical"),
              id: SNIPPET_ID,
              name: "Rules",
              version: options.availableVersion ?? "1.0.0",
            },
          ],
  };
}

function readyManifest(
  overrides: Partial<Pick<AuraManifest, "skills" | "snippets">>,
): WorkspaceModel["manifest"] {
  return {
    exists: true,
    path: "/home/dev/agents/aura.json",
    status: "ready",
    value: {
      apps: {},
      mcpServers: [],
      ownership: {},
      schemaVersion: 1,
      skills: overrides.skills ?? [],
      snippets: overrides.snippets ?? [],
    },
  };
}

function onlyFinding(workspaceModel: WorkspaceModel) {
  const finding = runChecks([managedContentUpdateCheck], workspaceModel).findings[0];
  if (finding === undefined) {
    throw new Error(`expected MGD-002 finding for ${SHARED_PATH}`);
  }
  return finding;
}
