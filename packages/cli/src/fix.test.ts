/* eslint-disable max-lines -- one fix-state matrix shares the same injected request fixtures. */
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
    const automatic = automaticCheck();
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
        checks: [automatic, guided],
        findings: [finding(automatic, "automatic"), finding(guided, "guided")],
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
    expect(aborted.fixes).toMatchObject([{ findingId: "automatic", status: "planned" }]);
    expect(legacy.fixes).toHaveLength(1);
    expect(legacyWizard.questions[0]?.[0]?.options[0]?.label).toBe("Use suggested resolution");
    expect(legacyWizard.questions[0]?.[0]?.options.at(-1)?.label).toBe("Skip");
  });

  it("reports guided-choice construction and preview failures without aborting", async () => {
    const brokenChoices = guidedCheck({
      guidedFixes: () => {
        throw new Error("choice construction failed");
      },
    });
    const construction = await runFixes(
      request({
        checks: [brokenChoices],
        findings: [finding(brokenChoices, "construction")],
        interactive: true,
        wizard: scriptedWizard([]),
      }),
    );
    const brokenPreview = guidedCheck({
      guidedFixes: () => [
        {
          id: "outside",
          label: "Write outside managed roots",
          plan: {
            operations: [{ content: "blocked", path: "/outside-aura-roots", type: "write" }],
            summary: "Write outside managed roots.",
          },
        },
      ],
    });
    const previewWizard = scriptedWizard([answer("guided-0", "skip")]);
    const preview = await runFixes(
      request({
        checks: [brokenPreview],
        findings: [finding(brokenPreview, "preview")],
        interactive: true,
        wizard: previewWizard,
      }),
    );

    expect(construction.fixDiagnostics).toMatchObject([
      { id: "fixture/GUIDED", message: expect.stringContaining("building guided choices") },
    ]);
    expect(preview.fixDiagnostics).toMatchObject([
      { id: "fixture/GUIDED", message: expect.stringContaining("previewing guided choice") },
    ]);
    expect(previewWizard.questions[0]?.[0]?.options.map((option) => option.label)).toEqual([
      "Skip",
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

  it("stops on a prepare-time conflict before confirmation", async () => {
    const fixtureModel = model();
    const check = automaticCheck({
      operations: [
        {
          path: join(fixtureModel.cwd, "conflicted.md"),
          relativePath: "../escape.md",
          type: "archive",
        },
      ],
      summary: "Archive a fixture.",
    });
    const wizard = scriptedWizard([], "accepted");
    const stderr = new TextOutput();

    const outcome = await runFixes(
      request({
        checks: [check],
        findings: [finding(check, "conflict")],
        model: fixtureModel,
        stderr,
        wizard,
      }),
    );

    expect(outcome).toMatchObject({ applied: false, exitCode: 2, fixes: [{ status: "failed" }] });
    expect(wizard.confirmations).toBe(0);
    expect(stderr.text).toContain("fixes are blocked");
  });

  it("reports unavailable and declined confirmations as planned fixes", async () => {
    const check = automaticCheck();
    const unavailableStderr = new TextOutput();
    const unavailable = await runFixes(
      request({
        checks: [check],
        findings: [finding(check, "unavailable")],
        stderr: unavailableStderr,
      }),
    );
    const wizard = scriptedWizard([], "declined");
    const declined = await runFixes(
      request({ checks: [check], findings: [finding(check, "declined")], wizard }),
    );

    expect(unavailable).toMatchObject({
      applied: false,
      exitCode: 2,
      fixes: [{ status: "planned" }],
    });
    expect(unavailableStderr.text).toContain("before fixes can be confirmed");
    expect(unavailableStderr.text).not.toContain("Aura");
    expect(declined).toMatchObject({ applied: false, fixes: [{ status: "planned" }] });
    expect(wizard.confirmations).toBe(1);
  });

  it("omits an all-noop plan without confirming or applying", async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-noop-fix-"));
    const path = join(root, "existing.md");
    try {
      await writeFile(path, "already current", "utf8");
      const check = automaticCheck(writePlanAt(root, "existing.md", "already current"));
      const wizard = scriptedWizard([], "accepted");
      const stdout = new TextOutput();
      let applyCalls = 0;

      const outcome = await runFixes(
        request({
          applyPlan: () => {
            applyCalls += 1;
            return Promise.reject(new Error("noop plan must not be applied"));
          },
          checks: [check],
          findings: [finding(check, "noop")],
          model: model(root),
          stdout,
          wizard,
        }),
      );

      expect(outcome).toMatchObject({ applied: false, fixes: [] });
      expect(stdout.text).toContain("Nothing to fix.");
      expect(wizard.confirmations).toBe(0);
      expect(applyCalls).toBe(0);
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
    expect(outcome.fixDiagnostics[0]?.message).toContain("2 completed operations");
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
