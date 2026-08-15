import type { Check, DetectedFinding, WorkspaceModel } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { runChecks } from "./index.js";

const MODEL: WorkspaceModel = {
  apps: [],
  cwd: "/workspace",
  homeDir: "/home/dev",
  instructionFiles: [],
  mcpServers: [],
  skills: [],
};

describe("runChecks", () => {
  it("stamps identity and default severity onto detected findings", () => {
    const check = createCheck("alpha/SEC-001", [
      { id: "first", message: "First finding" },
      { id: "second", message: "Second finding", severity: "info" },
    ]);

    expect(runChecks([check], MODEL)).toEqual([
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
    ]);
  });

  it("preserves check and finding declaration order", () => {
    const first = createCheck("alpha/FIRST", [
      { id: "one", message: "One" },
      { id: "two", message: "Two" },
    ]);
    const second = createCheck("alpha/SECOND", [{ id: "three", message: "Three" }]);

    expect(runChecks([first, second], MODEL).map((finding) => finding.id)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("returns a frozen empty collection when no checks are registered", () => {
    const findings = runChecks([], MODEL);

    expect(findings).toEqual([]);
    expect(Object.isFrozen(findings)).toBe(true);
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
