import type { AppModel, InstructionDocument, Scope } from "@tryaura/aura-sdk";
import { runChecks } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import checksCore from "../index.js";
import { app, gitignore, model, projectModel } from "../testing.js";
import { instructionLinkIntegrityCheck } from "./index.js";

describe("INS-006", () => {
  it("is registered as a guided error", () => {
    expect(checksCore.checks).toContain(instructionLinkIntegrityCheck);
    expect(instructionLinkIntegrityCheck).toMatchObject({
      defaultSeverity: "error",
      fixability: "guided",
      id: "INS-006",
      scope: "global",
    });
  });

  it("reports missing targets with content-free guided choices", () => {
    const source = document("/workspace/CLAUDE.md", "/workspace/gone.md", false);
    const workspace = model({ instructionFiles: [source] });
    const finding = runChecks([instructionLinkIntegrityCheck], workspace).findings[0];
    if (finding === undefined) {
      throw new Error("Expected a missing-link finding.");
    }

    expect(finding).toMatchObject({
      locations: [{ path: "/workspace/CLAUDE.md" }],
      metadata: {
        failure: "missing",
        sourcePath: "/workspace/CLAUDE.md",
        targetPath: "/workspace/gone.md",
      },
      severity: "error",
    });
    expect(instructionLinkIntegrityCheck.fix(finding)).toMatchObject({
      manualSteps: [
        expect.stringContaining("Create /workspace/gone.md"),
        expect.stringContaining("aura check"),
      ],
      operations: [],
    });
    expect(JSON.stringify(finding)).not.toContain("secret body");
  });

  it("reports cycles once with the complete path", () => {
    const documents = [
      document("/workspace/a.md", "/workspace/b.md"),
      document("/workspace/b.md", "/workspace/c.md"),
      document("/workspace/c.md", "/workspace/a.md"),
    ];
    const findings = runChecks(
      [instructionLinkIntegrityCheck],
      model({ instructionFiles: documents }),
    ).findings;

    expect(findings).toHaveLength(1);
    expect(findings[0]?.metadata?.["paths"]).toEqual([
      "/workspace/a.md",
      "/workspace/b.md",
      "/workspace/c.md",
      "/workspace/a.md",
    ]);
  });

  it("reports Claude Code depth overflow but not the five-hop boundary", () => {
    const sixHopDocuments = chain(6);
    const claude = withDocuments(
      app({ adapterId: "claude-code", displayName: "Claude Code" }),
      sixHopDocuments,
    );
    const findings = runChecks([instructionLinkIntegrityCheck], model({ apps: [claude] })).findings;

    expect(findings.filter((finding) => finding.metadata?.["failure"] === "depth")).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "error" });

    const fiveHopDocuments = chain(5);
    const supported = withDocuments(claude, fiveHopDocuments);
    expect(
      runChecks([instructionLinkIntegrityCheck], model({ apps: [supported] })).findings,
    ).toEqual([]);
  });

  it("warns for Codex imports while leaving unknown adapters alone", () => {
    const imported = document(
      "/home/dev/.codex/AGENTS.md",
      "/home/dev/.codex/shared.md",
      true,
      "global",
    );
    const codex = withDocuments(app({ adapterId: "codex", displayName: "Codex" }), [imported]);
    const unknown = withDocuments(app({ adapterId: "external", displayName: "External" }), [
      imported,
    ]);

    const codexFindings = runChecks(
      [instructionLinkIntegrityCheck],
      model({ apps: [codex] }),
    ).findings;
    expect(codexFindings).toHaveLength(1);
    expect(codexFindings[0]).toMatchObject({
      metadata: { appId: "codex", failure: "unsupported" },
      severity: "warn",
    });
    expect(runChecks([instructionLinkIntegrityCheck], model({ apps: [unknown] })).findings).toEqual(
      [],
    );
  });

  it("does not call a Codex import broken, since Codex never reads it", () => {
    const codex = withDocuments(app({ adapterId: "codex", displayName: "Codex" }), [
      document("/home/dev/.codex/AGENTS.md", "/home/dev/.codex/gone.md", false, "global"),
    ]);

    const findings = runChecks([instructionLinkIntegrityCheck], model({ apps: [codex] })).findings;

    expect(findings.map((finding) => finding.metadata?.["failure"])).toEqual(["unsupported"]);
    expect(findings.map((finding) => finding.severity)).toEqual(["warn"]);
  });

  it("still reports a broken symlink for an app that cannot follow imports", () => {
    const broken: InstructionDocument = {
      content: "",
      links: [{ kind: "symlink", targetPath: "/home/dev/agents/AGENTS.md", valid: false }],
      path: "/home/dev/.codex/AGENTS.md",
      scope: "global",
      sourceId: "codex.instructions.global",
    };
    const codex = withDocuments(app({ adapterId: "codex", displayName: "Codex" }), [broken]);

    expect(
      runChecks([instructionLinkIntegrityCheck], model({ apps: [codex] })).findings,
    ).toMatchObject([{ metadata: { failure: "missing" }, severity: "error" }]);
  });

  it("says the same thing about an out-of-bounds target whether or not it exists", () => {
    const findingsFor = (valid: boolean) =>
      runChecks(
        [instructionLinkIntegrityCheck],
        model({
          instructionFiles: [document("/workspace/AGENTS.md", "/home/dev/.ssh/id_rsa", valid)],
        }),
      ).findings;

    const present = findingsFor(true);
    expect(present).toMatchObject([{ metadata: { failure: "outside" }, severity: "warn" }]);
    expect(findingsFor(false)).toEqual(present);
  });

  it("resolves a project reference that stays inside the project", () => {
    const findings = runChecks(
      [instructionLinkIntegrityCheck],
      model({ instructionFiles: [document("/workspace/AGENTS.md", "/workspace/gone.md", false)] }),
    ).findings;

    expect(findings).toMatchObject([{ metadata: { failure: "missing" }, severity: "error" }]);
  });

  it("uses project-relative prose while preserving absolute structured paths", () => {
    const source = document("/repo/AGENTS.md", "/repo/rules/gone.md", false);
    const findings = runChecks(
      [instructionLinkIntegrityCheck],
      projectModel(gitignore(""), { instructionFiles: [source] }),
    ).findings;

    expect(findings).toMatchObject([
      {
        details:
          "Create rules/gone.md, correct the reference in AGENTS.md, or remove the reference.",
        locations: [{ path: "/repo/AGENTS.md" }],
        message: "AGENTS.md links to missing file rules/gone.md.",
        metadata: { sourcePath: "/repo/AGENTS.md", targetPath: "/repo/rules/gone.md" },
      },
    ]);
  });

  it("summarizes the link problems past the per-file cap", () => {
    const links = Array.from({ length: 25 }, (_value, index) => ({
      kind: "import" as const,
      targetPath: `/workspace/gone-${String(index).padStart(2, "0")}.md`,
      valid: false,
    }));
    const findings = runChecks(
      [instructionLinkIntegrityCheck],
      model({
        instructionFiles: [
          {
            content: "",
            links,
            path: "/workspace/AGENTS.md",
            scope: "project",
            sourceId: "test:many",
          },
        ],
      }),
    ).findings;

    expect(findings).toHaveLength(21);
    expect(findings[20]).toMatchObject({
      message: "/workspace/AGENTS.md has 5 further link problems not listed.",
      severity: "warn",
    });
  });

  it("treats a link two applications observe as valid when either resolved it", () => {
    const path = "/workspace/AGENTS.md";
    const target = "/workspace/shared.md";
    const findings = runChecks(
      [instructionLinkIntegrityCheck],
      model({
        instructionFiles: [
          document(path, target, false),
          { ...document(path, target, true), sourceId: "other-adapter" },
        ],
      }),
    ).findings;

    expect(findings).toEqual([]);
  });
});

function withDocuments(
  appModel: AppModel,
  instructionFiles: readonly InstructionDocument[],
): AppModel {
  return { ...appModel, instructionFiles };
}

function chain(hops: number): readonly InstructionDocument[] {
  return Array.from({ length: hops + 1 }, (_value, index) =>
    index === hops
      ? {
          content: "",
          links: [],
          path: `/workspace/${String(index)}.md`,
          scope: "project",
          sourceId: `chain:${String(index)}`,
        }
      : document(`/workspace/${String(index)}.md`, `/workspace/${String(index + 1)}.md`),
  );
}

function document(
  path: string,
  targetPath: string,
  valid = true,
  scope: Scope = "project",
): InstructionDocument {
  return {
    content: "secret body",
    links: [{ kind: "import", targetPath, valid }],
    path,
    scope,
    sourceId: `test:${path}`,
  };
}
