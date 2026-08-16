import { defineAdapter, defineCheck, type Adapter, type Check } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { checkCategory, selectChecks, type CheckSelection } from "./check-selection.js";

const CHECKS = [check("acme/ENV-001"), check("INS-001"), check("SEC-001")];
const ADAPTERS = [adapter("claude-code"), adapter("codex"), adapter("inventory", true)];

describe("selectChecks", () => {
  it("extracts categories from bare and namespaced local IDs", () => {
    expect(checkCategory("acme/SEC-001")).toBe("SEC");
    expect(checkCategory("ENV-001")).toBe("ENV");
  });

  it("resolves category and namespaced ID selectors case-insensitively", () => {
    expect(selection(["env"]).checks.map((candidate) => candidate.id)).toEqual(["acme/ENV-001"]);
    expect(selection(["ACME/env-001"]).checks.map((candidate) => candidate.id)).toEqual([
      "acme/ENV-001",
    ]);
  });

  it("resolves canonical app IDs and both Claude Code aliases", () => {
    for (const selector of ["claude-code", "claude", "CLAUDE_CODE"]) {
      expect(selection([selector]).adapters.map((candidate) => candidate.id)).toEqual([
        "claude-code",
        "inventory",
      ]);
    }
  });

  it("unions repeated selectors within a dimension", () => {
    const selected = selection(["ENV", "sec", "claude", "CODEX"]);

    expect(selected.checks.map((candidate) => candidate.id)).toEqual(["acme/ENV-001", "SEC-001"]);
    expect(selected.adapters.map((candidate) => candidate.id)).toEqual([
      "claude-code",
      "codex",
      "inventory",
    ]);
  });

  it("intersects the check and application dimensions", () => {
    const selected = selection(["ENV", "claude"]);

    expect(selected.checks.map((candidate) => candidate.id)).toEqual(["acme/ENV-001"]);
    expect(selected.adapters.map((candidate) => candidate.id)).toEqual([
      "claude-code",
      "inventory",
    ]);
  });

  // A synthetic adapter names no application a user could select, but checks read the model it
  // contributes. Filtering it out of a scan would report those checks as passed with no input.
  it("keeps synthetic adapters in the scan whatever the application selector is", () => {
    expect(selection(["codex"]).adapters.map((candidate) => candidate.id)).toContain("inventory");
    expect(selectChecks(CHECKS, ADAPTERS, ["inventory"]).status).toBe("unknown");
  });

  it("lets an exact check ID win over a category with the same spelling", () => {
    const exact = check("ENV");
    const result = selected(selectChecks([exact, check("ENV-001")], ADAPTERS, ["env"]));

    expect(result.checks).toEqual([exact]);
  });

  it("rejects unknown selectors with every valid selector family", () => {
    const result = selectChecks(CHECKS, ADAPTERS, ["unknown"]);

    expect(result).toEqual({
      message: [
        "unknown --only selector: unknown",
        "Valid categories: ENV, INS, SEC",
        "Valid check IDs: INS-001, SEC-001, acme/ENV-001",
        "Valid app IDs: claude-code, codex",
      ].join("\n"),
      status: "unknown",
    });
  });
});

function selection(selectors: readonly string[]): CheckSelection {
  return selected(selectChecks(CHECKS, ADAPTERS, selectors));
}

function selected(result: ReturnType<typeof selectChecks>): CheckSelection {
  if (result.status === "unknown") {
    throw new Error(result.message);
  }
  return result.selection;
}

function check(id: string): Check {
  return defineCheck({
    defaultSeverity: "warn",
    detect: () => [],
    explain: "Why this matters.\n\nHow to inspect it.",
    fixability: "manual",
    id,
    scope: "global",
    title: id,
  });
}

function adapter(id: string, synthetic = false): Adapter {
  return defineAdapter({
    detect: () => Promise.resolve({ installed: false }),
    displayName: id,
    files: () => [],
    id,
    parse: () => ({ instructionFiles: [], mcpServers: [], skills: [] }),
    supportedRange: ">=1",
    synthetic,
  });
}
