import type { InstructionDocument } from "@tryaura/aura-sdk";
import { runChecks } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import checksCore from "../index.js";
import { document, model } from "../testing.js";
import { duplicateInstructionsCheck } from "./index.js";

const GUIDANCE =
  "Always run the complete verification suite before merging changes because every package must remain healthy.";

describe("INS-003", () => {
  it("is registered as a report-only warning", () => {
    expect(checksCore.checks).toContain(duplicateInstructionsCheck);
    expect(duplicateInstructionsCheck).toMatchObject({
      defaultSeverity: "warn",
      fixability: "manual",
      id: "INS-003",
      scope: "global",
    });
  });

  it("reports normalized exact copies with content-free cluster metadata", () => {
    const findings = run([
      document("/workspace/CLAUDE.md", `- ${GUIDANCE}`),
      document("/workspace/.cursorrules", GUIDANCE.toUpperCase().replace(/\.$/u, "!!!")),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      checkId: "INS-003",
      details: "Copies: .cursorrules:1, CLAUDE.md:1.",
      locations: [
        { line: 1, path: "/workspace/.cursorrules" },
        { line: 1, path: "/workspace/CLAUDE.md" },
      ],
      message: "Identical guidance appears in .cursorrules, CLAUDE.md.",
      metadata: {
        identical: true,
        matchCount: 1,
        matches: [{ kind: "exact", left: 0, right: 1, similarity: 100 }],
        members: [
          { endLine: 1, path: "/workspace/.cursorrules", startLine: 1 },
          { endLine: 1, path: "/workspace/CLAUDE.md", startLine: 1 },
        ],
      },
      severity: "warn",
    });
    expect(JSON.stringify(findings)).not.toContain("complete verification suite");
  });

  it("names copies the user can find, including outside the workspace", () => {
    const findings = run([
      document("/workspace/apps/web/AGENTS.md", GUIDANCE),
      document("/workspace/apps/api/AGENTS.md", GUIDANCE),
      document("/home/dev/.codex/AGENTS.md", GUIDANCE),
      document("/elsewhere/AGENTS.md", GUIDANCE),
    ]);

    expect(findings[0]?.message).toBe(
      "Identical guidance appears in /elsewhere/AGENTS.md, ~/.codex/AGENTS.md and 2 more.",
    );
    expect(findings[0]?.details).toBe(
      "Copies: /elsewhere/AGENTS.md:1, ~/.codex/AGENTS.md:1, apps/api/AGENTS.md:1, apps/web/AGENTS.md:1.",
    );
  });

  it("reports a drifted copy with its rounded similarity", () => {
    const original = numberedGuidance(40);
    const changed = original.replace("instruction20", "replacement");
    const findings = run([
      document("/workspace/AGENTS.md", original),
      document("/workspace/CLAUDE.md", changed),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toBe(
      "Near-identical guidance appears in AGENTS.md, CLAUDE.md (at least 85% similar).",
    );
    expect(findings[0]?.metadata?.["matches"]).toEqual([
      { kind: "near", left: 0, right: 1, similarity: 85 },
    ]);
    expect(findings[0]?.metadata?.["identical"]).toBe(false);
  });

  it("does not call a cluster identical while any copy in it has drifted", () => {
    const original = numberedGuidance(40);
    const findings = run([
      document("/workspace/AGENTS.md", original),
      document("/workspace/CLAUDE.md", original),
      document("/workspace/rules.md", original.replace("instruction20", "replacement")),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.metadata?.["identical"]).toBe(false);
  });

  it("keeps IDs and output stable across input order and duplicate path entries", () => {
    const first = document("/workspace/CLAUDE.md", GUIDANCE);
    const second = document("/workspace/AGENTS.md", GUIDANCE);

    expect(run([first, second, { ...first, sourceId: "another-adapter" }])).toEqual(
      run([second, first]),
    );
  });

  it("keeps a finding's ID when an unrelated duplicate is inserted earlier", () => {
    const earlier =
      "Document surprising behavior in a comment so the next maintainer understands the constraint.";
    const before = run([
      document("/workspace/AGENTS.md", GUIDANCE),
      document("/workspace/CLAUDE.md", GUIDANCE),
    ]);
    const after = run([
      document("/workspace/AGENTS.md", `${earlier}\n\n${GUIDANCE}`),
      document("/workspace/CLAUDE.md", `${earlier}\n\n${GUIDANCE}`),
    ]);
    const guidanceFinding = after.find((finding) => finding.locations?.[0]?.line === 3);

    expect(guidanceFinding?.id).toBe(before[0]?.id);
  });

  it("gives each cluster between the same files its own ID", () => {
    const other =
      "Document surprising behavior in a comment so the next maintainer understands the constraint.";
    const findings = run([
      document("/workspace/AGENTS.md", `${GUIDANCE}\n\n${other}`),
      document("/workspace/CLAUDE.md", `${GUIDANCE}\n\n${other}`),
    ]);

    expect(findings).toHaveLength(2);
    expect(findings[0]?.id).not.toBe(findings[1]?.id);
    expect(findings.map((finding) => finding.id)).toEqual([
      expect.stringMatching(/^cluster:[a-f0-9]{64}$/u),
      expect.stringMatching(/^cluster:[a-f0-9]{64}$/u),
    ]);
  });

  it("groups multiple occurrences and summarizes additional files", () => {
    const findings = run([
      document("/workspace/AGENTS.md", `${GUIDANCE}\n\n${GUIDANCE}`),
      document("/workspace/CLAUDE.md", GUIDANCE),
      document("/workspace/rules.md", GUIDANCE),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toBe(
      "Identical guidance appears in AGENTS.md, CLAUDE.md and 1 more.",
    );
    expect(findings[0]?.metadata?.["members"]).toHaveLength(4);
  });

  it("ignores one file two applications reach through symlinks", () => {
    const shared = "/home/dev/.agents/AGENTS.md";

    expect(
      run([
        document("/home/dev/.claude/CLAUDE.md", GUIDANCE, { canonicalPath: shared }),
        document("/home/dev/.codex/AGENTS.md", GUIDANCE, { canonicalPath: shared }),
      ]),
    ).toEqual([]);
  });

  it("ignores repetition confined to one file", () => {
    expect(run([document("/workspace/AGENTS.md", `${GUIDANCE}\n\n${GUIDANCE}`)])).toEqual([]);
  });

  it("does not report copies whose embedded commands differ", () => {
    const lint = "Always run `pnpm lint` before pushing so that every package stays reviewable.";
    const publish =
      "Always run `pnpm publish --force` before pushing so that every package stays reviewable.";

    expect(
      run([document("/workspace/AGENTS.md", lint), document("/workspace/CLAUDE.md", publish)]),
    ).toEqual([]);
    expect(
      run([document("/workspace/AGENTS.md", lint), document("/workspace/CLAUDE.md", lint)]),
    ).toHaveLength(1);
  });

  it("reports re-wrapped prose and a copy with an unmatched backtick", () => {
    const rewrapped = GUIDANCE.replace(" before merging", "\nbefore merging");
    const unmatched = GUIDANCE.replace("run the", "`run the");

    expect(
      run([
        document("/workspace/AGENTS.md", GUIDANCE),
        document("/workspace/CLAUDE.md", rewrapped),
        document("/workspace/rules.md", unmatched),
      ]),
    ).toHaveLength(1);
  });

  it("leaves duplication that crosses the global and project tiers to INS-008", () => {
    expect(
      run([
        document("/home/dev/AGENTS.md", GUIDANCE),
        document("/workspace/AGENTS.md", GUIDANCE, { scope: "project" }),
      ]),
    ).toEqual([]);
  });

  it("still reports the copies one tier duplicates on its own", () => {
    const findings = run([
      document("/home/dev/AGENTS.md", GUIDANCE),
      document("/workspace/AGENTS.md", GUIDANCE, { scope: "project" }),
      document("/workspace/CLAUDE.md", GUIDANCE, { scope: "project" }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.locations).toEqual([
      { line: 1, path: "/workspace/AGENTS.md" },
      { line: 1, path: "/workspace/CLAUDE.md" },
    ]);
  });

  it("drops a scoped cluster connected only through a cross-scope member", () => {
    const bridge = numberedGuidance(40);
    const first = bridge.replace("instruction10", "replacement-a");
    const second = bridge.replace("instruction30", "replacement-b");

    expect(
      run([
        document("/home/dev/AGENTS.md", first),
        document("/home/dev/CLAUDE.md", second),
        document("/workspace/AGENTS.md", bridge, { scope: "project" }),
      ]),
    ).toEqual([]);
  });

  it("caps match metadata and detail locations while retaining totals", () => {
    const findings = run(
      Array.from({ length: 15 }, (_value, index) =>
        document(`/workspace/package-${String(index).padStart(2, "0")}/AGENTS.md`, GUIDANCE),
      ),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.metadata?.["matchCount"]).toBe(105);
    expect(findings[0]?.metadata?.["matches"]).toHaveLength(100);
    expect(findings[0]?.metadata?.["members"]).toHaveLength(15);
    expect(findings[0]?.details).toContain("and 9 more");
  });

  it("compares conditional rules only against rules of the same scope", () => {
    const conditional = document("/workspace/.cursor/rules/database.mdc", GUIDANCE, {
      metadata: { alwaysApply: false },
      scope: "project",
    });

    expect(run([conditional, document("/home/dev/AGENTS.md", GUIDANCE)])).toEqual([]);
    expect(
      run([conditional, document("/workspace/AGENTS.md", GUIDANCE, { scope: "project" })]),
    ).toHaveLength(1);
    expect(
      run([
        document("/home/dev/.cursor/rules/a.mdc", GUIDANCE, { metadata: { alwaysApply: false } }),
        document("/home/dev/.cursor/rules/b.mdc", GUIDANCE, { metadata: { alwaysApply: false } }),
      ]),
    ).toHaveLength(1);
  });
});

function run(instructionFiles: readonly InstructionDocument[]) {
  return runChecks([duplicateInstructionsCheck], model({ instructionFiles })).findings;
}

function numberedGuidance(count: number): string {
  return Array.from({ length: count }, (_value, index) => `instruction${index + 1}`).join(" ");
}
