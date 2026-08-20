import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  applyFixPlan,
  buildWorkspaceModel,
  createPluginRegistry,
  FixPlanApplyError,
  FixPlanError,
  prepareFixPlan,
} from "@tryaura/core";
import { afterEach, describe, expect, it } from "vitest";

import { applySetupPlan, type ApplySetupPlanOptions } from "./apply-retry.js";
import { planSetup } from "./planner.js";
import type { SetupRequest } from "./setup.js";
import {
  cleanupFixtures,
  createFixture,
  emptyMcpCatalog,
  emptySkillCatalog,
  emptySnippetCatalog,
} from "./testing.js";

afterEach(cleanupFixtures);

describe("applySetupPlan", () => {
  it("re-plans and applies when a file changed between the confirmation and the write", async () => {
    const { attempts, harness } = await createHarness();
    let failed = false;
    const result = await applySetupPlan({
      ...harness,
      applyPlan: (prepared, options) => {
        attempts.count += 1;
        if (!failed) {
          failed = true;
          return Promise.reject(racedError("complete"));
        }
        return applyFixPlan(prepared, options);
      },
    });

    expect(attempts.count).toBe(2);
    expect(result.appliedOperationCount).toBeGreaterThan(0);
    expect(harness.request.stdoutText()).toContain(
      "A configuration file changed while you were confirming; re-planning against its current contents.",
    );
    await expect(readFile(join(harness.homeDir, "agents", "aura.json"), "utf8")).resolves.toContain(
      '"schemaVersion": 1',
    );
  });

  it("gives up after bounded retries when the file keeps changing", async () => {
    const { attempts, harness } = await createHarness();
    const error = racedError("complete");

    await expect(
      applySetupPlan({
        ...harness,
        applyPlan: () => {
          attempts.count += 1;
          return Promise.reject(error);
        },
      }),
    ).rejects.toBe(error);
    expect(attempts.count).toBe(3);
  });

  it("never retries a failure whose rollback did not complete", async () => {
    const { attempts, harness } = await createHarness();
    const error = racedError("failed");

    await expect(
      applySetupPlan({
        ...harness,
        applyPlan: () => {
          attempts.count += 1;
          return Promise.reject(error);
        },
      }),
    ).rejects.toBe(error);
    expect(attempts.count).toBe(1);
    expect(harness.request.stdoutText()).not.toContain("re-planning");
  });

  it("rethrows failures that are not the apply-time race", async () => {
    const { attempts, harness } = await createHarness();
    const error = new FixPlanError("filesystem-error", "the write failed");

    await expect(
      applySetupPlan({
        ...harness,
        applyPlan: () => {
          attempts.count += 1;
          return Promise.reject(error);
        },
      }),
    ).rejects.toBe(error);
    expect(attempts.count).toBe(1);
  });
});

function racedError(rollback: "complete" | "failed"): FixPlanApplyError {
  return new FixPlanApplyError(
    new FixPlanError("filesystem-changed", "path changed after its preview was prepared"),
    rollback,
    0,
    rollback === "failed" ? ["operation 0: permission denied"] : [],
  );
}

interface Harness {
  readonly homeDir: string;
  readonly planInputs: ApplySetupPlanOptions["planInputs"];
  readonly prepared: ApplySetupPlanOptions["prepared"];
  readonly request: SetupRequest & { readonly stdoutText: () => string };
}

/** A real prepared plan — the fixture manifest write — over a real temporary home. */
async function createHarness(): Promise<{
  readonly attempts: { count: number };
  readonly harness: Harness;
}> {
  const fixture = await createFixture();
  const request = fixture.request(createPluginRegistry([]));
  const scan = await buildWorkspaceModel({
    adapters: [],
    environment: request.environment,
  });
  const planInputs: ApplySetupPlanOptions["planInputs"] = {
    appCatalog: [],
    interactive: false,
    isEnvironmentVariableSet: () => false,
    manifest: scan.model.manifest,
    mcpCatalog: emptyMcpCatalog(),
    model: scan.model,
    selections: { baseline: { createManifest: true, selected: ["manifest"] } },
    skillCatalog: emptySkillCatalog(),
    snippetCatalog: emptySnippetCatalog(),
  };
  const outcome = planSetup(planInputs);
  const prepared = await prepareFixPlan({ model: scan.model, plan: outcome.plan });
  return {
    attempts: { count: 0 },
    harness: {
      homeDir: fixture.homeDir,
      planInputs,
      prepared,
      request: Object.assign(request, { stdoutText: fixture.output }),
    },
  };
}
