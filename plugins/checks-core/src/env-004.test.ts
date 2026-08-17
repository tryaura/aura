import { describe, expect, it } from "vitest";

import { env004 } from "./env-004.js";
import { app, gitignore, model, projectModel, requireFinding } from "./testing.js";

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

  it("accepts Claude Code auto mode", () => {
    const automatic = app({
      adapterId: "claude-code",
      metadata: { claudePermissions: { project: { defaultMode: "auto" } } },
    });

    expect(env004.detect(projectModel(gitignore(""), { apps: [automatic] }))).toEqual([]);
  });

  it.each([
    ["trusted", 0],
    ["untrusted", 1],
    ["unknown", 1],
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
    expect(env004.explain).toContain('[projects."<project-root>"]');
  });

  it("does not inspect project settings outside a repository", () => {
    const codex = app({ adapterId: "codex", metadata: { projectTrust: "unknown" } });

    expect(env004.detect(model({ apps: [codex] }))).toEqual([]);
  });
});
