import { runChecks } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import checksCore from "./index.js";
import { legacyInstructionsCheck } from "./ins-004.js";
import { document, model } from "./testing.js";

describe("INS-004", () => {
  it("is registered as a guided warning", () => {
    expect(checksCore.checks).toContain(legacyInstructionsCheck);
    expect(legacyInstructionsCheck).toMatchObject({
      defaultSeverity: "warn",
      fixability: "guided",
      id: "INS-004",
      scope: "global",
    });
  });

  it("reports each unique legacy path without exposing its content", () => {
    const legacy = document("/workspace/.cursorrules", "private legacy guidance", {
      metadata: { legacy: true, tool: "cursor" },
      scope: "project",
    });
    const findings = runChecks(
      [legacyInstructionsCheck],
      model({
        instructionFiles: [legacy, { ...legacy, sourceId: "cursor.rules.project.legacy" }],
      }),
    ).findings;

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      checkId: "INS-004",
      locations: [{ path: "/workspace/.cursorrules" }],
      message: "Cursor legacy instructions remain at /workspace/.cursorrules.",
      metadata: { legacy: true, tool: "cursor" },
      severity: "warn",
    });
    expect(JSON.stringify(findings)).not.toContain("private legacy guidance");
  });

  it("provides setup guidance without moving a file before AURA-27", () => {
    const workspace = model({
      instructionFiles: [
        document("/home/dev/.windsurfrules", "legacy", {
          metadata: { legacy: true, tool: "windsurf" },
        }),
      ],
    });
    const finding = runChecks([legacyInstructionsCheck], workspace).findings[0];
    if (finding === undefined) {
      throw new Error("Expected INS-004 to report a finding.");
    }

    expect(legacyInstructionsCheck.fix(finding)).toMatchObject({
      manualSteps: [expect.stringContaining("aura setup"), expect.stringContaining("archived")],
      operations: [],
    });
  });
});
