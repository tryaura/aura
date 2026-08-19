import { describe, expect, it } from "vitest";

import { env004 } from "./env-004.js";
import { app, model, requireFinding } from "./testing.js";
import { gitignore, projectModel } from "./testing-repository.js";

describe("ENV-004", () => {
  it("uses project Claude settings ahead of global settings", () => {
    const restrictiveProject = app({
      adapterId: "claude-code",
      metadata: {
        claudePermissions: {
          global: { defaultMode: "default" },
          project: { defaultMode: "plan" },
        },
      },
      sources: [
        {
          exists: true,
          spec: {
            id: "claude-code.settings.project",
            kind: "config",
            path: "/repo/.claude/settings.json",
            scope: "project",
          },
        },
      ],
    });
    const normalProject = app({
      adapterId: "claude-code",
      metadata: {
        claudePermissions: {
          global: { defaultMode: "dontAsk" },
          project: { defaultMode: "default" },
        },
      },
    });

    const findings = env004.detect(projectModel(gitignore(""), { apps: [restrictiveProject] }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: "claude-permission-mode:plan",
      locations: [{ path: "/repo/.claude/settings.json" }],
    });
    expect(env004.detect(projectModel(gitignore(""), { apps: [normalProject] }))).toEqual([]);
  });

  it("falls back to global Claude settings when the project sets no mode", () => {
    const globalOnly = app({
      adapterId: "claude-code",
      metadata: {
        claudePermissions: {
          global: { defaultMode: "dontAsk" },
          project: { allowCount: 2 },
        },
      },
      sources: [
        {
          exists: true,
          spec: {
            id: "claude-code.settings.global",
            kind: "config",
            path: "/home/dev/.claude/settings.json",
            scope: "global",
          },
        },
      ],
    });
    const workspace = projectModel(gitignore(""), { apps: [globalOnly] });

    const findings = env004.detect(workspace);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: "claude-permission-mode:dontAsk",
      locations: [{ path: "/home/dev/.claude/settings.json" }],
      metadata: { sourceId: "claude-code.settings.global" },
    });

    const finding = requireFinding(findings[0], "ENV-004", "project", "warn");
    expect(env004.fix(finding, workspace)?.manualSteps?.[0]).toContain(
      "/home/dev/.claude/settings.json",
    );
  });

  it("ignores permission metadata that carries no default mode", () => {
    const counted = app({
      adapterId: "claude-code",
      metadata: { claudePermissions: { global: { allowCount: 3, denyCount: 1 } } },
    });

    expect(env004.detect(projectModel(gitignore(""), { apps: [counted] }))).toEqual([]);
  });

  it("accepts Claude Code acceptEdits mode", () => {
    const accepting = app({
      adapterId: "claude-code",
      metadata: { claudePermissions: { project: { defaultMode: "acceptEdits" } } },
    });

    expect(env004.detect(projectModel(gitignore(""), { apps: [accepting] }))).toEqual([]);
  });

  it("prefers local Claude settings over shared project settings", () => {
    const localOverride = app({
      adapterId: "claude-code",
      metadata: {
        claudePermissions: {
          local: { defaultMode: "plan" },
          project: { defaultMode: "default" },
        },
      },
      sources: [
        {
          exists: true,
          spec: {
            id: "claude-code.settings.local",
            kind: "config",
            path: "/repo/.claude/settings.local.json",
            scope: "project",
          },
        },
      ],
    });

    const findings = env004.detect(projectModel(gitignore(""), { apps: [localOverride] }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: "claude-permission-mode:plan",
      locations: [{ path: "/repo/.claude/settings.local.json" }],
      metadata: { sourceId: "claude-code.settings.local" },
    });
  });

  it("recommends only permission modes Claude Code actually has", () => {
    const restrictive = app({
      adapterId: "claude-code",
      metadata: { claudePermissions: { project: { defaultMode: "plan" } } },
      sources: [
        {
          exists: true,
          spec: {
            id: "claude-code.settings.project",
            kind: "config",
            path: "/repo/.claude/settings.json",
            scope: "project",
          },
        },
      ],
    });
    const workspace = projectModel(gitignore(""), { apps: [restrictive] });
    const finding = requireFinding(env004.detect(workspace)[0], "ENV-004", "project", "warn");
    const step = env004.fix(finding, workspace)?.manualSteps?.[0];

    expect(step).toContain("default or acceptEdits");
    expect(step).not.toContain("auto");
    expect(env004.explain).toContain("default or acceptEdits");
    expect(env004.explain).not.toContain("auto");
  });

  it.each([
    ["trusted", 0],
    ["untrusted", 1],
    ["unknown", 1],
    // An unparseable config.toml is already reported by the adapter, naming the file and saying
    // Codex ignores all of it. A trust finding on top would split one broken file into two
    // unrelated-looking symptoms, and the trust claim would be a guess besides.
    ["unreadable", 0],
  ])("handles Codex %s project trust", (trust, count) => {
    const codex = app({ adapterId: "codex", metadata: { projectTrust: trust } });

    expect(env004.detect(projectModel(gitignore(""), { apps: [codex] }))).toHaveLength(count);
  });

  it("includes the Codex config source in finding metadata", () => {
    const codex = app({ adapterId: "codex", metadata: { projectTrust: "unknown" } });

    expect(env004.detect(projectModel(gitignore(""), { apps: [codex] }))[0]?.metadata).toEqual({
      appId: "codex",
      sourceId: "codex.mcp.global",
      trust: "unknown",
    });
  });

  it("returns zero-operation guided plans with exact manual edits", () => {
    const codex = app({ adapterId: "codex", metadata: { projectTrust: "untrusted" } });
    const workspace = projectModel(gitignore(""), { apps: [codex] });
    const detected = env004.detect(workspace)[0];
    const finding = requireFinding(detected, "ENV-004", "project", "warn");
    const plan = env004.fix(finding, workspace);

    expect(plan?.operations).toEqual([]);
    expect(plan?.manualSteps?.[0]).toContain('[projects."/repo"]');
    expect(plan?.manualSteps?.[0]).toContain('trust_level = "trusted"');
    expect(env004.explain).toContain("primary Git checkout");
  });

  it("guides linked worktrees to trust the primary checkout", () => {
    const codex = app({ adapterId: "codex", metadata: { projectTrust: "unknown" } });
    const workspace = {
      ...projectModel(gitignore(""), { apps: [codex] }),
      gitMainWorktreeRoot: "/repos/main",
    };
    const finding = requireFinding(env004.detect(workspace)[0], "ENV-004", "project", "warn");

    expect(env004.fix(finding, workspace)?.manualSteps?.[0]).toContain('[projects."/repos/main"]');
  });

  it("does not inspect project settings outside a repository", () => {
    const codex = app({ adapterId: "codex", metadata: { projectTrust: "unknown" } });

    expect(env004.detect(model({ apps: [codex] }))).toEqual([]);
  });
});
