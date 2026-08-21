import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Check, FixPlan, WorkspaceModel } from "@tryaura/aura-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { applyFixPlan, prepareAutomaticFixes, runChecks } from "../index.js";

import { createPathPolicy, validatePlanPaths } from "./path-policy.js";
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
    // Neither an operation nor a step: a check that reported a finding and then asked for nothing
    // about it. Kept as a candidate it becomes a fix the report offers and no run ever performs.
    const inert = createCheck("alpha/INERT", () => ({ operations: [], summary: "Converged." }));

    const fixes = await prepareAutomaticFixes({
      checks: [guided, inert],
      findings: runChecks([guided, inert], fixture.model).findings,
      model: fixture.model,
    });

    expect(fixes.prepared).toBeUndefined();
    expect(fixes.manualSteps).toEqual(["Restart the application."]);
    expect(fixes.candidates.map((candidate) => candidate.checkId)).toEqual(["alpha/GUIDED"]);
  });

  it("leaves guided remediation for the interactive client", async () => {
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

    expect(fixes.prepared?.preview.operations).toHaveLength(1);
    expect(fixes.prepared?.preview.manualSteps).toEqual([]);
    expect(fixes.candidates.map((candidate) => candidate.checkId)).toEqual(["alpha/AUTO"]);
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

    expect(fixes).toEqual({ candidates: [], diagnostics: [], manualSteps: [] });
  });

  it("coalesces disjoint same-path writes into one atomic operation", async () => {
    const fixture = await createFixture();
    const path = join(fixture.model.cwd, "shared.md");
    await writeFile(path, "alpha\none\nmiddle\ntwo\nomega\n", "utf8");
    const first = createCheck("alpha/FIRST", () => ({
      operations: [{ content: "alpha\nONE\nmiddle\ntwo\nomega\n", path, type: "write" }],
      summary: "Change one.",
    }));
    const second = createCheck("alpha/SECOND", () => ({
      operations: [{ content: "alpha\none\nmiddle\nTWO\nomega\n", path, type: "write" }],
      summary: "Change two.",
    }));

    const fixes = await prepareAutomaticFixes({
      checks: [first, second],
      findings: runChecks([first, second], fixture.model).findings,
      model: fixture.model,
    });

    expect(fixes.prepared?.preview.operations).toHaveLength(1);
    expect(fixes.operationPreviewIndexes).toEqual([[0], [0]]);
    if (fixes.prepared === undefined) {
      throw new Error("expected a prepared plan");
    }
    await applyFixPlan(fixes.prepared, {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      stateHomeDir: fixture.root,
    });
    await expect(readFile(path, "utf8")).resolves.toBe("alpha\nONE\nmiddle\nTWO\nomega\n");
  });

  it("keeps disjoint same-path insertions in the places they were inserted", async () => {
    const fixture = await createFixture();
    const path = join(fixture.model.cwd, "shared.md");
    await writeFile(path, "alpha\none\ntwo\nthree\nomega\n", "utf8");
    const first = createCheck("alpha/FIRST", () => ({
      operations: [{ content: "alpha\nFIRST\none\ntwo\nthree\nomega\n", path, type: "write" }],
      summary: "Insert near the top.",
    }));
    const second = createCheck("alpha/SECOND", () => ({
      operations: [{ content: "alpha\none\ntwo\nthree\nSECOND\nomega\n", path, type: "write" }],
      summary: "Insert near the bottom.",
    }));

    const fixes = await prepareAutomaticFixes({
      checks: [first, second],
      findings: runChecks([first, second], fixture.model).findings,
      model: fixture.model,
    });

    expect(fixes.prepared?.preview.conflictedOperationCount).toBe(0);
    if (fixes.prepared === undefined) {
      throw new Error("expected a prepared plan");
    }
    await applyFixPlan(fixes.prepared, {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      stateHomeDir: fixture.root,
    });
    // Both insertions land where their check put them. Applying the patches one after another would
    // rebase the second onto line numbers the first had already shifted.
    await expect(readFile(path, "utf8")).resolves.toBe(
      "alpha\nFIRST\none\ntwo\nthree\nSECOND\nomega\n",
    );
  });

  it("blocks overlapping same-path writes without changing the file", async () => {
    const fixture = await createFixture();
    const path = join(fixture.model.cwd, "shared.md");
    const before = "alpha\none\nomega\n";
    await writeFile(path, before, "utf8");
    const first = createCheck("alpha/FIRST", () => ({
      operations: [{ content: "alpha\nONE\nomega\n", path, type: "write" }],
      summary: "Change one first way.",
    }));
    const second = createCheck("alpha/SECOND", () => ({
      operations: [{ content: "alpha\nDIFFERENT\nomega\n", path, type: "write" }],
      summary: "Change one second way.",
    }));

    const fixes = await prepareAutomaticFixes({
      checks: [first, second],
      findings: runChecks([first, second], fixture.model).findings,
      model: fixture.model,
    });

    expect(fixes.prepared?.preview).toMatchObject({
      conflictedOperationCount: 1,
      operations: [
        expect.objectContaining({
          conflict: expect.stringContaining("overlapping lines"),
          effect: "conflict",
        }),
      ],
    });
    await expect(readFile(path, "utf8")).resolves.toBe(before);
  });

  it("refuses to coalesce same-path writes whose spellings differ only by case", async () => {
    const fixture = await createFixture();
    // `PathPolicy.caseInsensitive` widens whenever `detectCaseSensitivity` cannot decide, so a
    // case-sensitive volume can still reach this policy. Coalescing under it would merge two
    // genuinely distinct files into one write and never write the second spelling at all.
    const policy = { ...(await createPathPolicy(fixture.model)), caseInsensitive: true };
    const plan: FixPlan = {
      operations: [
        { content: "one\n", path: join(fixture.model.cwd, "AGENTS.md"), type: "write" },
        { content: "two\n", path: join(fixture.model.cwd, "agents.md"), type: "write" },
      ],
      summary: "Two spellings of one claim.",
    };

    await expect(validatePlanPaths(plan, policy)).rejects.toMatchObject({
      code: "path-conflict",
      operationIndex: 1,
    });
  });

  it("blocks incompatible modes for same-path creates", async () => {
    const fixture = await createFixture();
    const path = join(fixture.model.cwd, "created.md");
    const first = createCheck("alpha/FIRST", () => ({
      operations: [{ content: "same\n", mode: 0o600, path, type: "write" }],
      summary: "Create private.",
    }));
    const second = createCheck("alpha/SECOND", () => ({
      operations: [{ content: "same\n", mode: 0o644, path, type: "write" }],
      summary: "Create public.",
    }));

    const fixes = await prepareAutomaticFixes({
      checks: [first, second],
      findings: runChecks([first, second], fixture.model).findings,
      model: fixture.model,
    });

    expect(fixes.prepared?.preview.operations[0]).toMatchObject({
      conflict: "same-path writes request incompatible file modes",
      effect: "conflict",
    });
  });

  it("skips a finding that downgrades itself to manual", async () => {
    const fixture = await createFixture();
    const check: Check = {
      ...createCheck("alpha/AUTO", () => writePlan(fixture.model)),
      detect: () => [
        { fixability: "manual", id: "undescribable", message: "Aura can only describe this." },
        { id: "finding", message: "Something is wrong." },
      ],
    };

    const fixes = await prepareAutomaticFixes({
      checks: [check],
      findings: runChecks([check], fixture.model).findings,
      model: fixture.model,
    });

    expect(fixes.candidates.map((candidate) => candidate.findingId)).toEqual(["finding"]);
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
