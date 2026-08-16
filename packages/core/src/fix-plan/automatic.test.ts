import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { Check, FixPlan, WorkspaceModel } from "@tryaura/aura-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { prepareAutomaticFixes, runChecks } from "../index.js";

import { createFixPlanFixture, type FixPlanFixture } from "./testing.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("prepareAutomaticFixes", () => {
  it("names the check that throws and keeps every other fix", async () => {
    const fixture = await createFixture();
    const faulty = createCheck("alpha/BOOM", () => {
      throw new Error("token=sk-secret leaked out of the plan builder");
    });
    const healthy = createCheck("alpha/OK", () => writePlan(fixture.model));

    const fixes = await prepareAutomaticFixes({
      checks: [faulty, healthy],
      findings: runChecks([faulty, healthy], fixture.model).findings,
      model: fixture.model,
    });

    expect(fixes.diagnostics).toEqual([
      {
        checkId: "alpha/BOOM",
        detail: "token=sk-secret leaked out of the plan builder",
        message:
          'alpha/BOOM failed while building a fix for "finding". Nothing it asked for was applied.',
      },
    ]);
    expect(fixes.prepared?.preview.operations).toHaveLength(1);
  });

  it("collects manual steps, deduplicated, even when no check produced an operation", async () => {
    const fixture = await createFixture();
    const guided = createCheck("alpha/GUIDED", () => ({
      manualSteps: ["Restart the application.", "Restart the application."],
      operations: [],
      summary: "Nothing automatic.",
    }));

    const fixes = await prepareAutomaticFixes({
      checks: [guided],
      findings: runChecks([guided], fixture.model).findings,
      model: fixture.model,
    });

    expect(fixes.prepared).toBeUndefined();
    expect(fixes.manualSteps).toEqual(["Restart the application."]);
  });

  it("merges guided and automatic remediations into one plan", async () => {
    const fixture = await createFixture();
    const guided = createCheck(
      "alpha/GUIDED",
      () => ({ ...writePlan(fixture.model, "guided.md"), manualSteps: ["Sign in again."] }),
      "guided",
    );
    const automatic = createCheck("alpha/AUTO", () => writePlan(fixture.model));

    const fixes = await prepareAutomaticFixes({
      checks: [guided, automatic],
      findings: runChecks([guided, automatic], fixture.model).findings,
      model: fixture.model,
    });

    // One plan, not two: the kernel applies a plan whole or not at all, and one undo entry should
    // cover everything a single command changed.
    expect(fixes.prepared?.preview.operations).toHaveLength(2);
    expect(fixes.prepared?.preview.manualSteps).toEqual(["Sign in again."]);
  });

  it("ignores manual checks without asking them for a plan", async () => {
    const fixture = await createFixture();
    const manual: Check = {
      defaultSeverity: "error",
      detect: () => [{ id: "finding", message: "Something is wrong." }],
      explain: "Test check.",
      fixability: "manual",
      id: "alpha/MANUAL",
      scope: "global",
      title: "Manual",
    };

    const fixes = await prepareAutomaticFixes({
      checks: [manual],
      findings: runChecks([manual], fixture.model).findings,
      model: fixture.model,
    });

    expect(fixes).toEqual({ diagnostics: [], manualSteps: [] });
  });
});

function writePlan(model: WorkspaceModel, name = "written.md"): FixPlan {
  return {
    operations: [{ content: "# written\n", path: join(model.cwd, name), type: "write" }],
    summary: "Write a file.",
  };
}

function createCheck(
  id: string,
  fix: () => FixPlan,
  fixability: "auto" | "guided" = "auto",
): Check {
  return {
    defaultSeverity: "error",
    detect: () => [{ id: "finding", message: "Something is wrong." }],
    explain: "Test check.",
    fix,
    fixability,
    id,
    scope: "global",
    title: id,
  };
}

async function createFixture(): Promise<FixPlanFixture> {
  const fixture = await createFixPlanFixture();
  temporaryDirectories.push(fixture.root);
  return fixture;
}
