import { afterEach, describe, expect, it } from "vitest";

import { hashContent } from "@tryaura/core";

import { planSnippets } from "./snippet-planner.js";
import { cleanupFixtures } from "./testing.js";
import {
  context,
  createRoot,
  file,
  missingManifest,
  readyManifest,
} from "./steps/snippets.test-support.js";
import type { SetupStepContext } from "./types.js";

afterEach(cleanupFixtures);

/** Resolves the catalog the way the step does, because the planner reads only what was loaded. */
async function planned(
  stepContext: SetupStepContext,
  snippets: SetupStepContext["selections"]["snippets"],
  source = "# Shared\n",
): Promise<ReturnType<typeof planSnippets>> {
  await stepContext.snippetCatalog.load();
  return planSnippets({ ...stepContext, selections: { snippets } }, source);
}

describe("snippet planner", () => {
  it("appends every resolvable selection even when one of them cannot be resolved", async () => {
    const root = await createRoot();
    const available = await file(root, "official/rules", "general", "Keep this rule.\n");
    const stepContext = context([available], missingManifest(), ["ghost/rules"]);

    const plan = await planned(stepContext, { selected: ["official/rules", "ghost/rules"] });

    expect(plan.content).toContain("Keep this rule.");
    expect(plan.manifestSnippets).toEqual([
      { hash: hashContent("Keep this rule.\n"), id: "official/rules" },
    ]);
    // A plugin that is merely absent is not a file whose state refuses a write, and a blocker here
    // would fail the whole run over it while leaving every other selection unapplied.
    expect(plan.notices).toEqual([
      {
        kind: "skipped",
        message: expect.stringContaining("ghost/rules was selected but not added"),
      },
    ]);
  });

  it("records the fingerprint of the text it appended", async () => {
    const root = await createRoot();
    const available = await file(root, "official/rules", "general", "Keep this rule.\n");
    const stepContext = context([available], missingManifest());

    const plan = await planned(stepContext, { selected: ["official/rules"] });

    expect(plan.manifestSnippets).toEqual([
      { hash: hashContent("Keep this rule.\n"), id: "official/rules" },
    ]);
  });

  it("keeps every install record when a run adds nothing", async () => {
    const root = await createRoot();
    const installed = await file(root, "official/rules", "general", "Keep this rule.\n");
    const stepContext = context([installed], readyManifest("official/rules"));

    const plan = await planned(stepContext, { selected: [] }, "# Shared\n\nKeep this rule.\n");

    expect(plan.content).toBe("# Shared\n\nKeep this rule.\n");
    expect(plan.updated).toBe(false);
    expect(plan.manifestSnippets).toEqual([{ id: "official/rules" }]);
  });

  it("leaves an installed selection alone rather than appending it twice", async () => {
    const root = await createRoot();
    const installed = await file(root, "official/rules", "general", "Keep this rule.\n");
    const stepContext = context([installed], readyManifest("official/rules"));

    const plan = await planned(stepContext, { selected: ["official/rules"] });

    expect(plan.updated).toBe(false);
    expect(plan.manifestSnippets).toEqual([{ id: "official/rules" }]);
  });
});
