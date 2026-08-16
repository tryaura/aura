import type {
  Check,
  DetectedFinding,
  FindingMetadataTablePresentation,
  WorkspaceModel,
} from "@tryaura/aura-sdk";
import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";
import { describe, expect, it } from "vitest";

import { runChecks } from "./index.js";

const MODEL: WorkspaceModel = createWorkspaceModel({
  manifest: { exists: false, path: "/home/dev/agents/aura.json", status: "missing" },
  sharedInstructions: { exists: false, path: "/home/dev/agents/AGENTS.md" },
});

describe("runChecks", () => {
  it("stamps identity and default severity onto detected findings", () => {
    const check = createCheck("alpha/SEC-001", [
      { id: "first", message: "First finding" },
      { id: "second", message: "Second finding", severity: "info" },
    ]);

    expect(runChecks([check], MODEL)).toEqual({
      diagnostics: [],
      findings: [
        {
          checkId: "alpha/SEC-001",
          id: "first",
          message: "First finding",
          scope: "global",
          severity: "warn",
        },
        {
          checkId: "alpha/SEC-001",
          id: "second",
          message: "Second finding",
          scope: "global",
          severity: "info",
        },
      ],
    });
  });

  it("drops properties a check attached beyond the shape of a finding", () => {
    // What a check that pastes raw source into its own object looks like at runtime, where
    // `readonly` and the declared shape are both gone.
    const detected = Object.assign(
      { id: "first", message: "First finding" },
      { detail: "AKIAIOSFODNN7EXAMPLE" },
    );

    expect(
      runChecks([createCheck("alpha/SEC-001", [detected])], MODEL).findings[0],
    ).not.toHaveProperty("detail");
  });

  it("preserves a declared metadata presentation hint", () => {
    const presentation: FindingMetadataTablePresentation = {
      columns: [{ heading: "File", key: "path" }],
      kind: "metadata-table",
      rowsKey: "files",
    };
    const finding = runChecks(
      [
        createCheck("alpha/SEC-001", [
          {
            id: "first",
            message: "First finding",
            metadata: { files: [{ path: "/workspace/AGENTS.md" }] },
            presentation,
          },
        ]),
      ],
      MODEL,
    ).findings[0];

    expect(finding?.presentation).toEqual(presentation);
  });

  it("skips a check that throws, keeps the rest, and withholds its untrusted text", () => {
    const broken: Check = {
      ...createCheck("alpha/BROKEN", []),
      detect: () => {
        throw new Error("secret source contents");
      },
    };
    const working = createCheck("alpha/WORKING", [{ id: "one", message: "One" }]);

    const run = runChecks([broken, working], MODEL);

    expect(run.findings.map((finding) => finding.id)).toEqual(["one"]);
    expect(run.diagnostics).toEqual([
      {
        checkId: "alpha/BROKEN",
        detail: "secret source contents",
        message:
          "Check alpha/BROKEN failed and was skipped. This is a bug in the check; report it to whoever ships the plugin.",
      },
    ]);
  });

  it("skips a check that returns a non-iterable value and keeps the rest", () => {
    const broken = createCheck("alpha/BROKEN", []);
    Object.defineProperty(broken, "detect", { value: () => undefined });
    const working = createCheck("alpha/WORKING", [{ id: "one", message: "One" }]);

    const run = runChecks([broken, working], MODEL);

    expect(run.findings.map((finding) => finding.id)).toEqual(["one"]);
    expect(run.diagnostics).toMatchObject([
      {
        checkId: "alpha/BROKEN",
        message:
          "Check alpha/BROKEN failed and was skipped. This is a bug in the check; report it to whoever ships the plugin.",
      },
    ]);
  });

  it("discards findings staged before a check result fails during iteration", () => {
    const detected: DetectedFinding[] = [{ id: "partial", message: "Partial" }];
    Object.defineProperty(detected, 1, {
      get: () => {
        throw new Error("invalid second finding");
      },
    });
    const broken = createCheck("alpha/BROKEN", detected);
    const working = createCheck("alpha/WORKING", [{ id: "one", message: "One" }]);

    const run = runChecks([broken, working], MODEL);

    expect(run.findings.map((finding) => finding.id)).toEqual(["one"]);
    expect(run.diagnostics).toHaveLength(1);
  });

  it("preserves check and finding declaration order", () => {
    const first = createCheck("alpha/FIRST", [
      { id: "one", message: "One" },
      { id: "two", message: "Two" },
    ]);
    const second = createCheck("alpha/SECOND", [{ id: "three", message: "Three" }]);

    expect(runChecks([first, second], MODEL).findings.map((finding) => finding.id)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("returns frozen empty collections when no checks are registered", () => {
    const run = runChecks([], MODEL);

    expect(run).toEqual({ diagnostics: [], findings: [] });
    expect(Object.isFrozen(run.findings)).toBe(true);
    expect(Object.isFrozen(run.diagnostics)).toBe(true);
  });
});

function createCheck(id: string, findings: readonly DetectedFinding[]): Check {
  return {
    defaultSeverity: "warn",
    detect: () => findings,
    explain: "Test check.",
    fixability: "manual",
    id,
    scope: "global",
    title: id,
  };
}
