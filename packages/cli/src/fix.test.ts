/* eslint-disable max-lines -- the guided and automatic CLI flow matrix shares one request fixture. */
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FixPlanApplyError, FixPlanError } from "@tryaura/core";

import { runFixes } from "./fix.js";
import {
  answer,
  automaticCheck,
  environment,
  finding,
  guidedCheck,
  model,
  request,
  scriptedWizard,
  TextOutput,
  writePlan,
  writePlanAt,
} from "./test-support/fix.js";

describe("runFixes guided remediation", () => {
  it("keeps plain --fix automatic-only", async () => {
    let guidedFixCalled = false;
    const guided = guidedCheck({
      fix: () => {
        guidedFixCalled = true;
        return writePlan("guided.md", "guided");
      },
    });

    const outcome = await runFixes(
      request({ checks: [guided], findings: [finding(guided, "guided")] }),
    );

    expect(guidedFixCalled).toBe(false);
    expect(outcome.fixes).toEqual([]);
  });

  it("merges selected named guided and automatic plans in original finding order", async () => {
    const guided = guidedCheck({
      guidedFixes: () => [
        {
          details: () => "Choice-specific context",
          id: "restore",
          label: "Restore registered content",
          plan: writePlan("guided.md", "guided"),
        },
      ],
    });
    const automatic = automaticCheck();
    const wizard = scriptedWizard([answer("guided-0", "choice:0")]);

    const outcome = await runFixes(
      request({
        checks: [automatic, guided],
        dryRun: true,
        findings: [finding(guided, "guided"), finding(automatic, "automatic")],
        interactive: true,
        wizard,
      }),
    );

    expect(outcome.fixes.map((fix) => [fix.findingId, fix.status])).toEqual([
      ["guided", "planned"],
      ["automatic", "planned"],
    ]);
    const preview = wizard.questions[0]?.[0]?.options[0]?.preview;
    expect(preview).toContain(guided.explain);
    expect(preview).toContain("Choice-specific context");
    expect(preview).toContain("diff --aura");
  });

  it("summarizes manual-only guided choices without reporting a filesystem fix", async () => {
    const guided = guidedCheck({
      guidedFixes: () => [
        {
          id: "manual",
          label: "Repair it myself",
          plan: {
            manualSteps: ["Edit the application setting."],
            operations: [],
            summary: "Repair the setting manually.",
          },
        },
      ],
    });
    const output = new TextOutput();

    const outcome = await runFixes(
      request({
        checks: [guided],
        findings: [finding(guided, "guided")],
        interactive: true,
        stdout: output,
        wizard: scriptedWizard([answer("guided-0", "choice:0")]),
      }),
    );

    expect(outcome.fixes).toEqual([]);
    expect(output.text).toContain("Steps to take yourself:");
    expect(output.text).toContain("Edit the application setting.");
  });

  it("supports Skip, abort, and the legacy suggested resolution", async () => {
    const guided = guidedCheck({ fix: () => writePlan("legacy.md", "legacy") });
    const skipped = await runFixes(
      request({
        checks: [guided],
        findings: [finding(guided, "guided")],
        interactive: true,
        wizard: scriptedWizard([answer("guided-0", "skip")]),
      }),
    );
    const aborted = await runFixes(
      request({
        checks: [guided],
        findings: [finding(guided, "guided")],
        interactive: true,
        wizard: scriptedWizard(["aborted"]),
      }),
    );
    const legacyWizard = scriptedWizard([answer("guided-0", "choice:0")]);
    const legacy = await runFixes(
      request({
        checks: [guided],
        dryRun: true,
        findings: [finding(guided, "guided")],
        interactive: true,
        wizard: legacyWizard,
      }),
    );

    expect(skipped.fixes).toEqual([]);
    expect(aborted.fixes).toEqual([]);
    expect(legacy.fixes).toHaveLength(1);
    expect(legacyWizard.questions[0]?.[0]?.options[0]?.label).toBe("Use suggested resolution");
    expect(legacyWizard.questions[0]?.[0]?.options.at(-1)?.label).toBe("Skip");
  });

  it("reports guided choice construction failures instead of silently hiding choices", async () => {
    const guided = guidedCheck({
      guidedFixes: () => {
        throw new Error("resolution context disappeared");
      },
    });

    const outcome = await runFixes(
      request({
        checks: [guided],
        findings: [finding(guided, "guided")],
        interactive: true,
        wizard: scriptedWizard([]),
      }),
    );

    expect(outcome.fixDiagnostics).toEqual([
      expect.objectContaining({
        detail: "resolution context disappeared",
        message: expect.stringContaining("failed while building guided choices"),
      }),
    ]);
  });

  it("confirms once and applies automatic and guided choices as one plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-guided-fix-"));
    try {
      const guided = guidedCheck({
        guidedFixes: () => [
          { id: "guided", label: "Guided", plan: writePlanAt(root, "guided.md", "guided") },
        ],
      });
      const automatic = automaticCheck(writePlanAt(root, "automatic.md", "automatic"));
      const wizard = scriptedWizard([answer("guided-1", "choice:0")], "accepted");

      const outcome = await runFixes(
        request({
          checks: [automatic, guided],
          environment: environment(root, () => new Date("2026-01-01T00:00:00.000Z")),
          findings: [finding(automatic, "automatic"), finding(guided, "guided")],
          interactive: true,
          model: model(root),
          stateHomeDir: root,
          wizard,
        }),
      );

      expect(outcome.applied).toBe(true);
      expect(wizard.confirmations).toBe(1);
      expect(outcome.fixes.map((fix) => fix.status)).toEqual(["applied", "applied"]);
      await expect(readFile(join(root, "automatic.md"), "utf8")).resolves.toBe("automatic");
      await expect(readFile(join(root, "guided.md"), "utf8")).resolves.toBe("guided");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reports an apply-time filesystem-state conflict without overwriting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-stale-fix-"));
    const path = join(root, "settings.md");
    try {
      await writeFile(path, "before", "utf8");
      const check = automaticCheck(writePlanAt(root, "settings.md", "after"));
      let changed = false;
      const output = new TextOutput((chunk) => {
        if (!changed && chunk.includes("Fix preview")) {
          changed = true;
          writeFileSync(path, "changed after preview", "utf8");
        }
      });

      const outcome = await runFixes(
        request({
          checks: [check],
          environment: environment(root, () => new Date("2026-01-01T00:00:00.000Z")),
          findings: [finding(check, "automatic")],
          model: model(root),
          stateHomeDir: root,
          stdout: output,
          yes: true,
        }),
      );

      expect(outcome.exitCode).toBe(2);
      expect(outcome.fixes).toMatchObject([{ status: "failed" }]);
      expect(outcome.fixDiagnostics).toEqual([]);
      await expect(readFile(path, "utf8")).resolves.toBe("changed after preview");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("says the plan was rolled back only when it was", async () => {
    const check = automaticCheck();
    const stderr = new TextOutput();

    const outcome = await runFixes(
      request({
        applyPlan: () => Promise.reject(applyError("complete", 0)),
        checks: [check],
        findings: [finding(check, "automatic")],
        stderr,
        yes: true,
      }),
    );

    expect(outcome.applied).toBe(false);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.fixes).toMatchObject([{ status: "failed" }]);
    expect(outcome.fixDiagnostics[0]?.message).toContain("were rolled back");
  });

  it("reports a half-applied plan as partial rather than claiming a rollback", async () => {
    const check = automaticCheck();
    const stderr = new TextOutput();

    const outcome = await runFixes(
      request({
        applyPlan: () => Promise.reject(applyError("failed", 2)),
        checks: [check],
        findings: [finding(check, "automatic")],
        stderr,
        yes: true,
      }),
    );

    expect(outcome.exitCode).toBe(3);
    expect(outcome.fixes).toMatchObject([{ status: "partial" }]);
    // The re-scan matters: after a partial write the report must describe the machine as it is.
    expect(outcome.applied).toBe(true);
    expect(outcome.fixDiagnostics[0]?.message).toContain("2 completed operation(s)");
    expect(outcome.fixDiagnostics[0]?.message).not.toContain("were rolled back");
    expect(stderr.text).toContain("could not be undone");
  });

  it("names --interactive when the only findings left are guided ones", async () => {
    const guided = guidedCheck({ fix: () => writePlan("guided.md", "guided") });
    const stdout = new TextOutput();

    await runFixes(request({ checks: [guided], findings: [finding(guided, "guided")], stdout }));

    expect(stdout.text).toContain("No executable fixes are available");
    expect(stdout.text).toContain("check --fix --interactive");
  });

  it("stays quiet about --interactive when nothing is guided", async () => {
    const manual = automaticCheck();
    const stdout = new TextOutput();

    await runFixes(request({ checks: [manual], findings: [], stdout }));

    expect(stdout.text).toContain("Nothing to fix.");
    expect(stdout.text).not.toContain("--interactive");
  });
});

function applyError(
  rollback: "complete" | "failed",
  appliedOperationCount: number,
): FixPlanApplyError {
  return new FixPlanApplyError(
    new FixPlanError("filesystem-error", "the write failed"),
    rollback,
    appliedOperationCount,
    rollback === "failed" ? ["operation 0: permission denied"] : [],
  );
}
