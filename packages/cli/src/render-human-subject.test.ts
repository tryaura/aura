import { describe, expect, it } from "vitest";

import { defineCheck, type Check } from "@tryaura/aura-sdk";
import type { PathDisplayRoots } from "@tryaura/core/display-path";

import { reportSubjects } from "./render-human-subject.js";
import type { ReportApp, ReportFinding } from "./report-shapes.js";

const ROOTS: PathDisplayRoots = { cwd: "/workspace/project", homeDir: "/fixture/home" };

const CHECKS: ReadonlyMap<string, Check> = new Map([
  [
    "fixture/SKL",
    defineCheck({
      defaultSeverity: "error",
      detect: () => [],
      explain: "Test check.",
      fixability: "manual",
      id: "fixture/SKL",
      scope: "global",
      title: "Shared skills have valid definitions",
    }),
  ],
]);

function app(appId: string, displayName: string, installed = true): ReportApp {
  return { appId, detection: { installed }, displayName };
}

function finding(
  overrides: Partial<ReportFinding> & { readonly findingId: string },
): ReportFinding {
  return {
    checkId: "fixture/SKL",
    fixability: "manual",
    message: "Something is wrong.",
    scope: "global",
    severity: "error",
    ...overrides,
  };
}

function subjectsOf(findings: readonly ReportFinding[], apps: readonly ReportApp[] = []) {
  return reportSubjects({ all: findings, apps, checks: CHECKS, roots: ROOTS, shown: findings });
}

describe("reportSubjects", () => {
  it("files a finding under the application its metadata names", () => {
    const subjects = subjectsOf(
      [finding({ findingId: "one", metadata: { appId: "claude-code" } })],
      [app("claude-code", "Claude Code")],
    );

    expect(subjects).toHaveLength(1);
    expect(subjects[0]?.kind).toBe("app");
    expect(subjects[0]?.label).toBe("Claude Code");
  });

  it("ignores an appId naming an application this scan never detected", () => {
    const subjects = subjectsOf([
      finding({
        findingId: "one",
        locations: [{ path: "/fixture/home/.claude.json" }],
        metadata: { appId: "not-a-real-app" },
      }),
    ]);

    expect(subjects[0]?.kind).toBe("path");
    expect(subjects[0]?.label).toBe("~/.claude.json");
  });

  it("ignores an appId naming an application that is not installed", () => {
    const subjects = subjectsOf(
      [
        finding({
          findingId: "one",
          locations: [{ path: "/fixture/home/.claude.json" }],
          metadata: { appId: "windsurf" },
        }),
      ],
      [app("windsurf", "Windsurf", false)],
    );

    expect(subjects[0]?.kind).toBe("path");
  });

  it("falls back to the producing check's title when there is nowhere else to file it", () => {
    const subjects = subjectsOf([finding({ findingId: "one" })]);

    expect(subjects[0]?.kind).toBe("check");
    expect(subjects[0]?.label).toBe("Shared skills have valid definitions");
  });

  it("falls back to the check id when the check is not registered", () => {
    const subjects = subjectsOf([finding({ checkId: "fixture/GONE", findingId: "one" })]);

    expect(subjects[0]?.label).toBe("fixture/GONE");
  });

  it("files a finding naming several files under the first alone", () => {
    const subjects = subjectsOf([
      finding({
        findingId: "one",
        locations: [{ path: "/fixture/home/a.md" }, { path: "/fixture/home/b.md" }],
      }),
    ]);

    expect(subjects).toHaveLength(1);
    expect(subjects[0]?.label).toBe("~/a.md");
  });

  it("orders worst first, then largest, then by label", () => {
    const subjects = subjectsOf(
      [
        finding({ findingId: "w1", metadata: { appId: "zed" }, severity: "warn" }),
        finding({ findingId: "e1", metadata: { appId: "codex" } }),
        finding({ findingId: "e2", metadata: { appId: "claude-code" } }),
        finding({ findingId: "e3", metadata: { appId: "claude-code" } }),
      ],
      [app("zed", "Zed"), app("codex", "Codex"), app("claude-code", "Claude Code")],
    );

    expect(subjects.map((subject) => subject.label)).toEqual(["Claude Code", "Codex", "Zed"]);
  });

  it("breaks a tie by label without consulting the machine's locale", () => {
    const subjects = subjectsOf(
      [
        finding({ findingId: "one", metadata: { appId: "b-app" } }),
        finding({ findingId: "two", metadata: { appId: "a-app" } }),
      ],
      [app("b-app", "Beta"), app("a-app", "Alpha")],
    );

    expect(subjects.map((subject) => subject.label)).toEqual(["Alpha", "Beta"]);
  });

  it("counts every member in the total while rendering only the shown ones", () => {
    const all = [
      finding({ findingId: "one", metadata: { appId: "claude-code" } }),
      finding({ findingId: "two", metadata: { appId: "claude-code" }, severity: "warn" }),
      finding({ findingId: "three", metadata: { appId: "claude-code" } }),
    ];
    const subjects = reportSubjects({
      all,
      apps: [app("claude-code", "Claude Code")],
      checks: CHECKS,
      roots: ROOTS,
      shown: all.slice(0, 1),
    });

    expect(subjects[0]?.findings).toHaveLength(1);
    expect(subjects[0]?.shown).toEqual({ errors: 1, informational: 0, warnings: 0 });
    expect(subjects[0]?.total).toEqual({ errors: 2, informational: 0, warnings: 1 });
  });

  it("drops a subject the ceiling emptied entirely", () => {
    const all = [
      finding({ findingId: "one", metadata: { appId: "claude-code" } }),
      finding({ findingId: "two", metadata: { appId: "codex" } }),
    ];
    const subjects = reportSubjects({
      all,
      apps: [app("claude-code", "Claude Code"), app("codex", "Codex")],
      checks: CHECKS,
      roots: ROOTS,
      shown: all.slice(0, 1),
    });

    expect(subjects.map((subject) => subject.label)).toEqual(["Claude Code"]);
  });
});
