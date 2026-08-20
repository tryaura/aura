import type { AuraManifest, WorkspaceModel } from "@tryaura/aura-sdk";
import { runChecks } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { managedContentUpdateCheck } from "./mgd-002.js";
import { model } from "./testing.js";

describe("MGD-002", () => {
  it("reports and plans a clean bundled skill update", () => {
    const current = workspace();
    const finding = onlyFinding(current);
    const choice = managedContentUpdateCheck.guidedFixes?.(finding, current)[0];

    expect(finding.message).toContain("1.0.0 to 2.0.0");
    expect(choice?.id).toBe("update");
    expect(choice?.label).toBe("Update to 2.0.0");
    expect(choice?.plan.operations.at(-1)).toMatchObject({ path: "/home/dev/agents/aura.json" });
  });

  it("offers a lower source revision as a deliberate switch", () => {
    const current = workspace({ availableVersion: "0.9.0" });
    const finding = onlyFinding(current);
    const choice = managedContentUpdateCheck.guidedFixes?.(finding, current)[0];

    expect(finding.metadata?.["kind"]).toBe("skill-diverged");
    expect(choice?.label).toBe("Switch to 0.9.0");
  });

  it("silences pinned skills and ignores install-once snippets", () => {
    const current = workspace({ pinned: true, snippets: ["official/rules"] });

    expect(runChecks([managedContentUpdateCheck], current).findings).toEqual([]);
  });

  it("requires local skill changes to be reviewed before an update", () => {
    const current = workspace({ sharedHash: "c".repeat(64) });
    const finding = onlyFinding(current);
    const choice = managedContentUpdateCheck.guidedFixes?.(finding, current)[0];

    expect(choice).toMatchObject({ id: "resolve-drift", plan: { operations: [] } });
  });
});

function workspace(
  options: {
    readonly availableVersion?: string;
    readonly pinned?: boolean;
    readonly sharedHash?: string;
    readonly snippets?: readonly string[];
  } = {},
): WorkspaceModel {
  const installedHash = "a".repeat(64);
  return {
    ...model({
      manifest: readyManifest({
        skills: [
          {
            id: "review",
            pinned: options.pinned ?? false,
            source: "plugin:official",
            treeHash: installedHash,
            version: "1.0.0",
          },
        ],
        snippets: (options.snippets ?? []).map((id) => ({ id })),
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
          treeHash: options.sharedHash ?? installedHash,
        },
      ],
    }),
    availableSkills: [
      {
        description: "Current skill.",
        files: [{ content: "---\nname: review\ndescription: Review.\n---\n", path: "SKILL.md" }],
        id: "review",
        name: "Review",
        source: { id: "plugin:official", kind: "bundled", name: "Official" },
        treeHash: "b".repeat(64),
        version: options.availableVersion ?? "2.0.0",
      },
    ],
  };
}

function readyManifest(
  overrides: Pick<AuraManifest, "skills" | "snippets">,
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
      skills: overrides.skills,
      snippets: overrides.snippets,
    },
  };
}

function onlyFinding(workspaceModel: WorkspaceModel) {
  const finding = runChecks([managedContentUpdateCheck], workspaceModel).findings[0];
  if (finding === undefined) {
    throw new Error("expected an MGD-002 skill finding");
  }
  return finding;
}
