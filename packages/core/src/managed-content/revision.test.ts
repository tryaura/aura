import type { ResolvedSkillPack, SharedSkillEntry } from "@tryaura/aura-sdk";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { managedContentRevisionStatus, planSharedSkillTreeUpdate } from "./revision.js";

describe("managedContentRevisionStatus", () => {
  it("reports a republished same-version revision as an update", () => {
    expect(managedContentRevisionStatus("1.0.0", "aaa", "1.0.0", "bbb")).toBe("update");
    expect(managedContentRevisionStatus("1.0.0", "aaa", "1.0.0", "aaa")).toBe("current");
  });

  it("reports a higher semver version as an update", () => {
    expect(managedContentRevisionStatus("1.0.0", "aaa", "2.0.0", "bbb")).toBe("update");
  });

  it("separates a rollback from an already-installed revision", () => {
    // Reporting a rollback as "current" would let setup write the older content over the newer
    // recorded revision; reporting it as "update" would present it as an upgrade. It is neither.
    expect(managedContentRevisionStatus("2.0.0", "aaa", "1.0.0", "bbb")).toBe("diverged");
  });

  it("separates versions it cannot order from an already-installed revision", () => {
    // Silently holding these was a dead end: no review offered it and no check reported it.
    expect(managedContentRevisionStatus("2024-05", "aaa", "2024-06", "bbb")).toBe("diverged");
  });
});

describe("planSharedSkillTreeUpdate", () => {
  it("removes stale entries but keeps directories the desired tree still fills", () => {
    const root = join("/home", "dev", "agents", "skills", "review");
    const desired = pack([
      { content: "body", path: "SKILL.md" },
      { content: "ref", path: "nested/deep/reference.md" },
    ]);
    const existing: readonly SharedSkillEntry[] = [
      { kind: "directory", path: join(root, "nested") },
      { kind: "directory", path: join(root, "nested", "deep") },
      { kind: "directory", path: join(root, "gone") },
      { kind: "file", path: join(root, "gone", "old.md") },
      { kind: "file", path: join(root, "SKILL.md") },
    ];

    const operations = planSharedSkillTreeUpdate(root, existing, desired);

    expect(
      operations.filter((operation) => operation.type === "remove").map((o) => o.path),
    ).toEqual([join(root, "gone", "old.md"), join(root, "gone")]);
    expect(operations.filter((operation) => operation.type === "write").map((o) => o.path)).toEqual(
      [join(root, "SKILL.md"), join(root, "nested", "deep", "reference.md")],
    );
  });
});

function pack(files: readonly { readonly content: string; readonly path: string }[]) {
  return {
    files,
    id: "review",
    description: "Review skill.",
    name: "Review",
    source: { id: "plugin:official", kind: "bundled", name: "Official" },
    treeHash: "tree",
    version: "1.0.0",
  } satisfies ResolvedSkillPack;
}
