import type { AppModel, InstructionDocument, JsonObject } from "@tryaura/aura-sdk";
import { runChecks } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import checksCore from "../index.js";
import { app, document, model } from "../testing.js";
import {
  DEFAULT_CONTEXT_BUDGET_BYTES,
  instructionContextBudgetCheck,
  LARGE_CONTEXT_BUDGET_BYTES,
} from "./index.js";

describe("INS-007", () => {
  it("is registered as an informational manual check", () => {
    expect(checksCore.checks).toContain(instructionContextBudgetCheck);
    expect(instructionContextBudgetCheck).toMatchObject({
      defaultSeverity: "info",
      fixability: "manual",
      id: "INS-007",
      scope: "global",
    });
  });

  it("stays quiet at the byte threshold and measures UTF-8 above it", () => {
    const exact = withDocuments(app({ adapterId: "codex" }), [
      document("/home/dev/.codex/AGENTS.md", "a".repeat(DEFAULT_CONTEXT_BUDGET_BYTES)),
    ]);
    expect(run(exact)).toEqual([]);

    const utf8 = withDocuments(app({ adapterId: "codex", displayName: "Codex" }), [
      document("/home/dev/.codex/AGENTS.md", "é".repeat(16_001)),
    ]);
    expect(run(utf8)).toMatchObject([
      {
        id: "codex",
        metadata: {
          approxTokens: 8_001,
          files: [
            {
              bytes: 32_002,
              path: "/home/dev/.codex/AGENTS.md",
              share: 1,
            },
          ],
          totalBytes: 32_002,
        },
        severity: "info",
      },
    ]);
  });

  it("follows modeled Claude imports transitively and counts shared paths once", () => {
    const root = linkedDocument("/workspace/CLAUDE.md", "a".repeat(20_000), [
      "/workspace/a.md",
      "/workspace/b.md",
    ]);
    const a = linkedDocument("/workspace/a.md", "b".repeat(8_000), ["/workspace/shared.md"]);
    const b = linkedDocument("/workspace/b.md", "c".repeat(8_000), ["/workspace/shared.md"]);
    const shared = document("/workspace/shared.md", "d".repeat(8_000));
    const claude = withDocuments(app({ adapterId: "claude-code", displayName: "Claude Code" }), [
      root,
    ]);

    const findings = runChecks(
      [instructionContextBudgetCheck],
      model({ apps: [claude], instructionFiles: [a, b, shared] }),
    ).findings;

    expect(findings).toHaveLength(1);
    expect(findings[0]?.metadata).toMatchObject({ approxTokens: 11_000, totalBytes: 44_000 });
    expect(metadataFiles(findings[0]?.metadata)).toEqual([
      { bytes: 20_000, path: "/workspace/CLAUDE.md", share: 20_000 / 44_000 },
      { bytes: 8_000, path: "/workspace/a.md", share: 8_000 / 44_000 },
      { bytes: 8_000, path: "/workspace/b.md", share: 8_000 / 44_000 },
      { bytes: 8_000, path: "/workspace/shared.md", share: 8_000 / 44_000 },
    ]);
  });

  it("counts Codex entries directly without following import-shaped links", () => {
    const global = linkedDocument("/home/dev/.codex/AGENTS.md", "a".repeat(16_001), [
      "/workspace/imported.md",
    ]);
    const project = document("/workspace/AGENTS.md", "b".repeat(16_000), { scope: "project" });
    const codex = withDocuments(app({ adapterId: "codex" }), [global, project]);
    const findings = runChecks(
      [instructionContextBudgetCheck],
      model({
        apps: [codex],
        instructionFiles: [document("/workspace/imported.md", "x".repeat(100_000))],
      }),
    ).findings;

    expect(findings[0]?.metadata).toMatchObject({ approxTokens: 8_001, totalBytes: 32_001 });
    expect(metadataFiles(findings[0]?.metadata)).toHaveLength(2);
  });

  it("lists Cursor conditional rules without adding them to the effective total", () => {
    const always = document("/workspace/.cursorrules", "a".repeat(32_001), {
      scope: "project",
    });
    const explicit = document("/workspace/.cursor/rules/always.mdc", "b".repeat(2_000), {
      metadata: { alwaysApply: true },
      scope: "project",
    });
    const conditional = document("/workspace/.cursor/rules/database.mdc", "c".repeat(100_000), {
      metadata: { alwaysApply: false, globs: "migrations/**" },
      scope: "project",
    });
    const cursor = withDocuments(app({ adapterId: "cursor", displayName: "Cursor" }), [
      always,
      explicit,
      conditional,
    ]);

    const finding = run(cursor)[0];
    expect(finding?.metadata).toMatchObject({ approxTokens: 8_501, totalBytes: 34_001 });
    expect(finding?.message).toContain("across 2 file(s), and lists 1 conditional file(s)");
    // The conditional rule carries no share: it is not part of the total every share divides by.
    expect(metadataFiles(finding?.metadata)).toEqual([
      {
        bytes: 100_000,
        conditional: true,
        path: "/workspace/.cursor/rules/database.mdc",
      },
      { bytes: 32_001, path: "/workspace/.cursorrules", share: 32_001 / 34_001 },
      {
        bytes: 2_000,
        path: "/workspace/.cursor/rules/always.mdc",
        share: 2_000 / 34_001,
      },
    ]);

    const conditionalOnly = withDocuments(app({ adapterId: "cursor" }), [conditional]);
    expect(run(conditionalOnly)).toEqual([]);
  });

  it("does not reach through a conditional Cursor rule to what only it imports", () => {
    const always = {
      ...linkedDocument("/workspace/.cursor/rules/always.mdc", "a".repeat(32_001), [
        "/workspace/.cursor/rules/database.mdc",
      ]),
      metadata: { alwaysApply: true },
    };
    const conditional = {
      ...linkedDocument("/workspace/.cursor/rules/database.mdc", "b".repeat(1_000), [
        "/workspace/shared/schema.md",
      ]),
      metadata: { alwaysApply: false, globs: "migrations/**" },
    };
    const behindConditional = document("/workspace/shared/schema.md", "c".repeat(50_000));
    const cursor = withDocuments(app({ adapterId: "cursor", displayName: "Cursor" }), [
      always,
      conditional,
    ]);

    const findings = runChecks(
      [instructionContextBudgetCheck],
      model({ apps: [cursor], instructionFiles: [behindConditional] }),
    ).findings;

    expect(findings[0]?.metadata).toMatchObject({ totalBytes: 32_001 });
    expect(metadataFiles(findings[0]?.metadata)).toEqual([
      { bytes: 32_001, path: "/workspace/.cursor/rules/always.mdc", share: 1 },
      { bytes: 1_000, conditional: true, path: "/workspace/.cursor/rules/database.mdc" },
    ]);
  });

  it("lists the largest files and says how many it left out", () => {
    const files = Array.from({ length: 120 }, (_, index) =>
      document(`/workspace/rule-${String(index).padStart(3, "0")}.md`, "a".repeat(index + 1)),
    );
    const codex = withDocuments(app({ adapterId: "codex", displayName: "Codex" }), [
      document("/home/dev/.codex/AGENTS.md", "b".repeat(32_001)),
      ...files,
    ]);

    const finding = run(codex)[0];
    const reported = metadataFiles(finding?.metadata);
    expect(Array.isArray(reported) && reported.length).toBe(100);
    expect(finding?.metadata).toMatchObject({ omittedFiles: 21 });
    expect(finding?.details).toContain("Listing the 100 largest of 121 file(s).");
  });

  it("escalates copy without severity and skips synthetic adapters", () => {
    const huge = document("/workspace/AGENTS.md", "a".repeat(LARGE_CONTEXT_BUDGET_BYTES + 1));
    const codex = withDocuments(app({ adapterId: "codex" }), [huge]);
    const finding = run(codex)[0];
    expect(finding).toMatchObject({ id: "codex", severity: "info" });
    expect(finding?.details).toContain("well above");
    expect(JSON.stringify(finding)).not.toContain(huge.content);

    expect(run(withDocuments(app({ adapterId: "codex", synthetic: true }), [huge]))).toEqual([]);
  });

  it("says an unmodeled application was not measured, once it is over budget", () => {
    const huge = document("/workspace/AGENTS.md", "a".repeat(LARGE_CONTEXT_BUDGET_BYTES + 1));
    const unmodeled = run(withDocuments(app({ adapterId: "external" }), [huge]));

    expect(unmodeled).toMatchObject([
      {
        id: "external",
        metadata: { appId: "external", evaluated: false, totalBytes: 80_001 },
        severity: "info",
      },
    ]);
    expect(unmodeled[0]?.message).toContain("does not model how it loads them");
    expect(unmodeled[0]?.presentation).toBeUndefined();
    expect(JSON.stringify(unmodeled)).not.toContain(huge.content);

    const small = document("/workspace/AGENTS.md", "a".repeat(DEFAULT_CONTEXT_BUDGET_BYTES));
    expect(run(withDocuments(app({ adapterId: "external" }), [small]))).toEqual([]);
  });
});

function run(appModel: AppModel) {
  return runChecks([instructionContextBudgetCheck], model({ apps: [appModel] })).findings;
}

function withDocuments(
  appModel: AppModel,
  instructionFiles: readonly InstructionDocument[],
): AppModel {
  return { ...appModel, instructionFiles };
}

function linkedDocument(
  path: string,
  content: string,
  targets: readonly string[],
): InstructionDocument {
  return {
    ...document(path, content),
    links: targets.map((targetPath) => ({ kind: "import", targetPath, valid: true })),
  };
}

function metadataFiles(metadata: JsonObject | undefined) {
  return metadata?.["files"];
}
