import type {
  AppModel,
  AuraManifest,
  AuraManifestSkill,
  AuraManifestState,
  ResolvedSkillPack,
  SharedSkillState,
  WorkspaceModel,
} from "@tryaura/aura-sdk";
import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";
import { describe, expect, it } from "vitest";

import { emptySnippetCatalog } from "./testing.js";
import { planSkills } from "./skill-planner.js";
import type { SetupStepContext, SkillSelection } from "./types.js";

const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);
const SHARED_ROOT = "/home/dev/agents/skills";

describe("skill setup planner", () => {
  it("installs a selected pack once and links every managed supported app", () => {
    const result = planSkills(
      context({
        apps: [
          app("claude-code", "/home/dev/.claude/skills"),
          app("codex", "/home/dev/.codex/skills"),
        ],
        availableSkills: [pack("plugin:fixture", HASH_1)],
        selections: [{ id: "review", source: "plugin:fixture" }],
      }),
    );

    expect(result.blockers).toEqual([]);
    expect(result.manifestSkills).toEqual([manifestSkill("plugin:fixture", HASH_1)]);
    expect(result.operations).toEqual([
      {
        content: "---\nname: review\n---\n",
        path: `${SHARED_ROOT}/review/SKILL.md`,
        type: "write",
      },
      { path: "/home/dev/.claude/skills/review", target: `${SHARED_ROOT}/review`, type: "symlink" },
      { path: "/home/dev/.codex/skills/review", target: `${SHARED_ROOT}/review`, type: "symlink" },
    ]);
  });

  it("rejects simultaneous selections with the same source-local ID", () => {
    const result = planSkills(
      context({
        availableSkills: [pack("plugin:alpha", HASH_1), pack("plugin:beta", HASH_2)],
        selections: [
          { id: "review", source: "plugin:alpha" },
          { id: "review", source: "plugin:beta" },
        ],
      }),
    );

    expect(result.operations).toEqual([]);
    expect(result.blockers[0]?.reason).toContain("more than one source");
  });

  it("switches sources only while the existing shared copy matches its provenance", () => {
    const previous = manifestSkill("plugin:alpha", HASH_1);
    const safe = planSkills(
      context({
        availableSkills: [pack("plugin:beta", HASH_2)],
        previous: [previous],
        selections: [{ id: "review", source: "plugin:beta" }],
        sharedSkills: [shared(HASH_1)],
      }),
    );
    const edited = planSkills(
      context({
        availableSkills: [pack("plugin:beta", HASH_2)],
        previous: [previous],
        selections: [{ id: "review", source: "plugin:beta" }],
        sharedSkills: [shared("f".repeat(64))],
      }),
    );

    expect(safe.manifestSkills).toEqual([manifestSkill("plugin:beta", HASH_2)]);
    expect(safe.operations).toContainEqual({
      content: "---\nname: review\n---\n",
      path: `${SHARED_ROOT}/review/SKILL.md`,
      type: "write",
    });
    expect(edited.manifestSkills).toEqual([previous]);
    expect(edited.operations).toEqual([]);
    expect(edited.manualSteps[0]).toContain("local edits");
  });

  it("preserves a pinned revision and cleanly removes an explicitly deselected copy", () => {
    const pinned = { ...manifestSkill("plugin:fixture", HASH_1), pinned: true };
    const kept = planSkills(
      context({
        availableSkills: [pack("plugin:fixture", HASH_2)],
        previous: [pinned],
        selections: [{ id: "review", source: "plugin:fixture" }],
        sharedSkills: [shared(HASH_1)],
      }),
    );
    const removed = planSkills(
      context({
        apps: [app("codex", "/home/dev/.codex/skills", `${SHARED_ROOT}/review`)],
        previous: [pinned],
        selections: [],
        sharedSkills: [shared(HASH_1)],
      }),
    );

    expect(kept.manifestSkills).toEqual([pinned]);
    expect(kept.operations).toEqual([]);
    expect(removed.manifestSkills).toEqual([]);
    expect(removed.operations.map((operation) => operation.type)).toEqual([
      "remove",
      "remove",
      "remove",
    ]);
    expect(removed.operations[0]).toMatchObject({ path: "/home/dev/.codex/skills/review" });
  });

  it("keeps edited copies and foreign deployment paths, while healthy links are no-ops", () => {
    const previous = manifestSkill("plugin:fixture", HASH_1);
    const edited = planSkills(
      context({
        apps: [app("codex", "/home/dev/.codex/skills", "/foreign/review")],
        availableSkills: [pack("plugin:fixture", HASH_1)],
        previous: [previous],
        selections: [],
        sharedSkills: [shared(HASH_2)],
      }),
    );
    const healthy = planSkills(
      context({
        apps: [app("codex", "/home/dev/.codex/skills", `${SHARED_ROOT}/review`)],
        availableSkills: [pack("plugin:fixture", HASH_1)],
        previous: [previous],
        selections: [{ id: "review", source: "plugin:fixture" }],
        sharedSkills: [shared(HASH_1)],
      }),
    );
    const foreign = planSkills(
      context({
        apps: [app("codex", "/home/dev/.codex/skills", "/foreign/review")],
        availableSkills: [pack("plugin:fixture", HASH_1)],
        previous: [previous],
        selections: [{ id: "review", source: "plugin:fixture" }],
        sharedSkills: [shared(HASH_1)],
      }),
    );
    const realDirectory = planSkills(
      context({
        apps: [app("codex", "/home/dev/.codex/skills", undefined, "directory")],
        availableSkills: [pack("plugin:fixture", HASH_1)],
        previous: [previous],
        selections: [{ id: "review", source: "plugin:fixture" }],
        sharedSkills: [shared(HASH_1)],
      }),
    );

    expect(edited.manifestSkills).toEqual([previous]);
    expect(edited.operations).toEqual([]);
    expect(edited.manualSteps[0]).toContain("local edits");
    expect(healthy.operations).toEqual([]);
    expect(foreign.operations).toEqual([]);
    expect(foreign.manualSteps[0]).toContain("not an Aura-managed skill link");
    expect(realDirectory.operations).toEqual([]);
    expect(realDirectory.manualSteps[0]).toContain("not an Aura-managed skill link");
  });
});

interface ContextOptions {
  readonly apps?: readonly AppModel[];
  readonly availableSkills?: readonly ResolvedSkillPack[];
  readonly previous?: readonly AuraManifestSkill[];
  readonly selections: readonly SkillSelection[];
  readonly sharedSkills?: readonly SharedSkillState[];
}

function context(options: ContextOptions): SetupStepContext {
  const value: AuraManifest = {
    apps: Object.fromEntries(
      (options.apps ?? []).map((entry) => [entry.adapterId, { managed: true }]),
    ),
    mcpServers: [],
    ownership: {},
    schemaVersion: 1,
    skills: options.previous ?? [],
    snippets: [],
  };
  const manifest: AuraManifestState = {
    exists: true,
    mode: 0o600,
    path: "/home/dev/agents/aura.json",
    status: "ready" as const,
    value,
  };
  const model: WorkspaceModel = createWorkspaceModel({
    apps: options.apps ?? [],
    availableSkills: options.availableSkills ?? [],
    manifest,
    sharedInstructions: { exists: false, path: "/home/dev/agents/AGENTS.md" },
    sharedSkills: options.sharedSkills ?? [],
  });
  return {
    appCatalog: [],
    manifest,
    model,
    selections: { skills: { selected: options.selections } },
    snippetCatalog: emptySnippetCatalog(),
  };
}

function pack(source: `plugin:${string}`, treeHash: string): ResolvedSkillPack {
  return {
    description: "Review code.",
    files: [{ content: "---\nname: review\n---\n", path: "SKILL.md" }],
    id: "review",
    name: "Review",
    source: { id: source, kind: "bundled", name: source },
    treeHash,
    version: "1.0.0",
  };
}

function manifestSkill(source: AuraManifestSkill["source"], treeHash: string): AuraManifestSkill {
  return { id: "review", pinned: false, source, treeHash, version: "1.0.0" };
}

function shared(treeHash: string): SharedSkillState {
  return {
    entries: [
      { kind: "directory", path: `${SHARED_ROOT}/review` },
      { kind: "file", path: `${SHARED_ROOT}/review/SKILL.md` },
    ],
    id: "review",
    path: `${SHARED_ROOT}/review`,
    treeHash,
  };
}

function app(
  id: string,
  directory: string,
  linkTarget?: string,
  pathKind: "directory" | "symlink" = "symlink",
): AppModel {
  const path = `${directory}/review`;
  return {
    adapterId: id,
    detection: { installed: true },
    displayName: id,
    instructionFiles: [],
    mcpServers: [],
    metadata: undefined,
    skillDirectories: [{ id: `${id}.skills.global`, path: directory, scope: "global" }],
    skills: [],
    sourceFiles:
      linkTarget === undefined && pathKind === "symlink"
        ? []
        : [
            {
              exists: true,
              pathKind,
              problem: undefined,
              spec: { id: `${id}.skills.global/review`, kind: "skills", path, scope: "global" },
              ...(linkTarget === undefined ? {} : { symlinkTarget: linkTarget }),
            },
          ],
    support: { status: "unknown", supportedRange: ">=1" },
  };
}
