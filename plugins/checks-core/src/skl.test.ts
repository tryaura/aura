/* eslint-disable max-lines -- the four skill-check matrices share model and manifest fixtures. */
import type {
  AuraManifest,
  AppModel,
  InstalledSkill,
  SharedSkillState,
  WorkspaceModel,
} from "@tryaura/aura-sdk";
import { runChecks } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { skl001 } from "./skl-001.js";
import { skl002 } from "./skl-002.js";
import { skl003 } from "./skl-003.js";
import { skl004 } from "./skl-004.js";
import { app, model } from "./testing.js";

const SHARED_ROOT = "/home/dev/agents/skills";
const REVIEW_PATH = `${SHARED_ROOT}/review`;

describe("SKL-001", () => {
  it("accepts a complete shared skill", () => {
    expect(runChecks([skl001], withShared([sharedSkill()])).findings).toEqual([]);
  });

  it("reports definition, field, naming, description, and reference failures", () => {
    const missingDefinition = sharedSkill({ definitionStatus: "missing-file", id: "missing" });
    const invalidDefinition = sharedSkill({
      definitionStatus: "invalid-frontmatter",
      id: "invalid",
    });
    const malformedFields = sharedSkill({
      description: "x".repeat(301),
      id: "wrong-dir",
      invalidFrontmatterFields: ["name"],
      name: undefined,
      references: [{ path: `${SHARED_ROOT}/wrong-dir/gone.md`, valid: false }],
    });

    expect(
      runChecks(
        [skl001],
        withShared([missingDefinition, invalidDefinition, malformedFields]),
      ).findings.map((finding) => finding.id),
    ).toEqual([
      "missing:missing-file",
      "invalid:invalid-frontmatter",
      "wrong-dir:invalid-name-field",
      "wrong-dir:long-description",
      `wrong-dir:missing-reference:${SHARED_ROOT}/wrong-dir/gone.md`,
    ]);
  });

  it("names the entry that stopped the walk instead of blaming a definition it never reached", () => {
    // walkPath stops at the first unresolvable entry and walks in sorted order, so an unsupported
    // sibling sorting before SKILL.md leaves the definition unread. Calling that "no SKILL.md"
    // sends the user to repair a file that is already correct.
    const blocked = sharedSkill({
      definitionStatus: "unreadable",
      description: undefined,
      id: "blocked",
      name: undefined,
      problem: "unsupported",
      problemDetail: "Makefile is a symbolic link",
      treeHash: undefined,
    });
    const findings = runChecks([skl001], withShared([blocked])).findings;

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      details: "Makefile is a symbolic link",
      id: "blocked:unreadable-tree",
      message: 'Shared skill "blocked" could not be read in full (unsupported).',
    });
  });

  it("rejects unicode and directory-name mismatches", () => {
    const findings = runChecks(
      [skl001],
      withShared([
        sharedSkill({ id: "unicode", name: "résumé" }),
        sharedSkill({ id: "directory", name: "different-name" }),
      ]),
    ).findings;

    expect(findings.map((finding) => finding.id)).toEqual([
      "unicode:invalid-name",
      "unicode:name-mismatch",
      "directory:name-mismatch",
    ]);
    expect(
      findings[0] === undefined ? undefined : skl001.fix(findings[0]).manualSteps,
    ).toHaveLength(2);
  });
});

describe("SKL-002", () => {
  it("plans missing links for Claude Code and Codex directories", () => {
    const workspace = managedWorkspace([
      skillApp("claude-code", ["/home/dev/.claude/skills", "/workspace/.claude/skills"]),
      skillApp("codex", ["/home/dev/.codex/skills"]),
    ]);
    const findings = runChecks([skl002], workspace).findings;

    expect(findings).toHaveLength(3);
    expect(findings.every((finding) => finding.fixability !== "manual")).toBe(true);
    expect(findings.map((finding) => skl002.fix(finding, workspace)?.operations[0])).toMatchObject([
      { target: REVIEW_PATH, type: "symlink" },
      { target: REVIEW_PATH, type: "symlink" },
      { target: REVIEW_PATH, type: "symlink" },
    ]);
  });

  it("skips unmanaged and skill-incapable applications and preserves foreign entries", () => {
    const foreign = skillApp("codex", ["/home/dev/.codex/skills"], {
      status: { kind: "directory" },
    });
    const workspace = managedWorkspace([foreign, app({ adapterId: "cursor" })], {
      managed: { codex: true, cursor: true },
    });

    expect(runChecks([skl002], workspace).findings[0]).toMatchObject({ fixability: "manual" });
    const unmanaged = managedWorkspace([skillApp("codex", ["/home/dev/.codex/skills"])], {
      managed: { codex: false },
    });
    expect(runChecks([skl002], unmanaged).findings).toEqual([]);
  });
});

describe("SKL-003", () => {
  it("repairs recoverable links and removes only unclaimed Aura links", () => {
    const recoverable = model({
      apps: [skillApp("codex", ["/home/dev/.codex/skills"], { broken: true })],
      sharedSkills: [sharedSkill()],
    });
    const recoverableFinding = runChecks([skl003], recoverable).findings[0];
    expect(recoverableFinding?.metadata).toMatchObject({ action: "relink" });
    expect(
      recoverableFinding === undefined ? undefined : skl003.fix(recoverableFinding, recoverable),
    ).toMatchObject({ operations: [{ target: REVIEW_PATH, type: "symlink" }] });

    const unclaimed = model({
      apps: [skillApp("codex", ["/home/dev/.codex/skills"], { broken: true })],
    });
    const unclaimedFinding = runChecks([skl003], unclaimed).findings[0];
    expect(unclaimedFinding?.metadata).toMatchObject({ action: "remove" });
    expect(
      unclaimedFinding === undefined ? undefined : skl003.fix(unclaimedFinding, unclaimed),
    ).toMatchObject({ operations: [{ type: "remove" }] });
  });

  it("requires manual recovery for claimed or foreign dangling links", () => {
    const claimed = managedWorkspace(
      [skillApp("codex", ["/home/dev/.codex/skills"], { broken: true })],
      { shared: [] },
    );
    expect(runChecks([skl003], claimed).findings[0]).toMatchObject({
      fixability: "manual",
      metadata: { action: "reinstall" },
    });

    const foreign = model({
      apps: [
        skillApp("codex", ["/home/dev/.codex/skills"], {
          broken: true,
          target: "/home/dev/foreign/review",
        }),
      ],
    });
    expect(runChecks([skl003], foreign).findings[0]).toMatchObject({
      fixability: "manual",
      metadata: { action: "foreign" },
    });
  });

  it("accepts healthy links", () => {
    const workspace = model({
      apps: [skillApp("codex", ["/home/dev/.codex/skills"], { healthy: true })],
      sharedSkills: [sharedSkill()],
    });
    expect(runChecks([skl003], workspace).findings).toEqual([]);
  });
});

describe("SKL-004", () => {
  it("reports duplicate invocation names within one app and not across apps", () => {
    const duplicate = skill("codex", "global-review", "/home/dev/.codex/skills/global-review");
    const second = {
      ...skill("codex", "project-review", "/workspace/.codex/skills/project-review"),
      invocationName: duplicate.invocationName,
    };
    const otherApp = skill("claude-code", "review", "/home/dev/.claude/skills/review");
    const workspace = model({
      apps: [
        app({ adapterId: "codex", skills: [duplicate, second] }),
        app({ adapterId: "claude-code", skills: [otherApp] }),
      ],
    });
    const findings = runChecks([skl004], workspace).findings;

    expect(findings).toHaveLength(1);
    expect(skl004.fixability).toBe("guided");
    expect(findings[0]).toMatchObject({
      metadata: { appId: "codex", invocationName: "review" },
    });
    expect(findings[0]?.locations).toHaveLength(2);
  });

  it("reports duplicate legacy deployments within one application", () => {
    // SKL-002 deploys every manifest skill to every directory an app declares, and Claude Code
    // declares one of each scope. Grouping across scopes would make SKL-002's own fix raise an
    // error here, telling the user to delete a link Aura had just created.
    const global = skill("claude-code", "review", "/home/dev/.claude/skills/review");
    const project = {
      ...skill("claude-code", "review", "/workspace/.claude/skills/review"),
      scope: "project" as const,
    };
    const workspace = model({
      apps: [app({ adapterId: "claude-code", skills: [global, project] })],
    });

    expect(runChecks([skl004], workspace).findings).toHaveLength(1);
  });
});

function withShared(sharedSkills: readonly SharedSkillState[]): WorkspaceModel {
  return model({ sharedSkills });
}

function sharedSkill(overrides: Partial<SharedSkillState> = {}): SharedSkillState {
  const id = overrides.id ?? "review";
  const path = `${SHARED_ROOT}/${id}`;
  return {
    definitionStatus: "ready",
    description: "Review code changes.",
    entries: [
      { kind: "directory", path },
      { kind: "file", path: `${path}/SKILL.md` },
    ],
    id,
    name: id,
    path,
    skillFilePath: `${path}/SKILL.md`,
    treeHash: "a".repeat(64),
    version: "1.0.0",
    ...overrides,
  };
}

function skillApp(
  adapterId: "claude-code" | "codex",
  directories: readonly string[],
  options: {
    readonly broken?: boolean;
    readonly healthy?: boolean;
    readonly status?: { readonly kind: "directory" };
    readonly target?: string;
  } = {},
) {
  const skillDirectories: NonNullable<AppModel["skillDirectories"]> = directories.map(
    (path, index) => ({
      id: `${adapterId}.skills.${String(index)}`,
      path,
      scope: index === 0 ? "global" : "project",
    }),
  );
  const installed =
    options.broken === true || options.healthy === true
      ? [
          skill(adapterId, "review", `${directories[0]}/review`, {
            resolved: options.healthy === true,
            ...(options.target === undefined ? {} : { target: options.target }),
          }),
        ]
      : [];
  const sources: AppModel["sourceFiles"] =
    options.status === undefined
      ? []
      : [
          {
            exists: true,
            pathKind: options.status.kind,
            spec: {
              id: `${adapterId}.skills.0/review`,
              kind: "skills",
              path: `${directories[0]}/review`,
              scope: "global",
            },
          },
        ];
  return app({ adapterId, displayName: adapterId, skillDirectories, skills: installed, sources });
}

function skill(
  appId: string,
  id: string,
  path: string,
  options: { readonly resolved?: boolean; readonly target?: string } = {},
): InstalledSkill {
  const target = options.target ?? REVIEW_PATH;
  return {
    appId,
    definitionStatus: options.resolved === undefined ? "ready" : "missing-file",
    id,
    invocationName: "review",
    name: "review",
    path,
    sourceId: `${appId}.skills.global`,
    ...(options.resolved === undefined
      ? {}
      : {
          ...(options.resolved ? { symlinkResolvedPath: REVIEW_PATH } : {}),
          symlinkTargetPath: target,
        }),
  };
}

function managedWorkspace(
  apps: WorkspaceModel["apps"],
  options: {
    readonly managed?: Readonly<Record<string, boolean>>;
    readonly shared?: readonly SharedSkillState[];
  } = {},
): WorkspaceModel {
  const managed =
    options.managed ?? Object.fromEntries(apps.map((entry) => [entry.adapterId, true]));
  const manifest: AuraManifest = {
    apps: Object.fromEntries(
      Object.entries(managed).map(([id, value]) => [id, { managed: value }]),
    ),
    mcpServers: [],
    ownership: {},
    schemaVersion: 1,
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
  };
  return model({
    apps,
    manifest: {
      exists: true,
      path: "/home/dev/agents/aura.json",
      status: "ready",
      value: manifest,
    },
    sharedSkills: options.shared ?? [sharedSkill()],
  });
}
