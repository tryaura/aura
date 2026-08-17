import { runChecks } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import checksCore from "./index.js";
import { sha256 } from "./hashing.js";
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
      id: `legacy:${sha256("/workspace/.cursorrules").slice(0, 16)}`,
      locations: [{ path: "/workspace/.cursorrules" }],
      message: "Cursor legacy instructions remain at .cursorrules.",
      metadata: { displayPath: ".cursorrules", legacy: true, tool: "cursor" },
      severity: "warn",
    });
    expect(JSON.stringify(findings)).not.toContain("private legacy guidance");
  });

  it("ignores current instruction formats the inventory carries alongside legacy ones", () => {
    const findings = runChecks(
      [legacyInstructionsCheck],
      model({
        instructionFiles: [
          document("/workspace/GEMINI.md", "current", {
            metadata: { legacy: false, tool: "gemini" },
            scope: "project",
          }),
        ],
      }),
    ).findings;

    expect(findings).toEqual([]);
  });

  it("provides setup guidance without moving the file itself", () => {
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

    // The guidance names the file the way the message did, not by an absolute path the same report
    // never showed.
    expect(finding.message).toContain("~/.windsurfrules");
    expect(legacyInstructionsCheck.fix(finding)).toMatchObject({
      manualSteps: [expect.stringContaining("aura setup"), expect.stringContaining("archived")],
      operations: [],
      summary: "Consolidate the legacy instruction file at ~/.windsurfrules.",
    });
  });
});
