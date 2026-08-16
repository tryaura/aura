import type { Writable } from "node:stream";

import type { FixPlanPreview } from "@tryaura/core";

import { renderManualSteps, renderOperationPreviews } from "../preview-render.js";
import { safe } from "../render.js";
import type { SetupBlocker } from "./planner.js";

/** Shows the whole plan — changes, blockers, manual steps — before the one confirmation. */
export function renderSetupSummary(
  preview: FixPlanPreview,
  blockers: readonly SetupBlocker[],
  withDetail: boolean,
  output: Writable,
): void {
  output.write(`Plan: ${safe(preview.summary)}\n`);

  if (preview.changedOperationCount === 0 && preview.conflictedOperationCount === 0) {
    output.write("  Nothing to change.\n");
  }
  renderOperationPreviews(preview.operations, withDetail, output);
  renderBlockers(blockers, output);
  renderManualSteps(preview.manualSteps, output);

  if (!withDetail && preview.changedOperationCount > 0) {
    output.write("\nRe-run with --detail to see the full diff of every change.\n");
  }
}

function renderBlockers(blockers: readonly SetupBlocker[], output: Writable): void {
  if (blockers.length === 0) {
    return;
  }

  output.write("\nBlocked, and left out of the plan:\n");
  for (const blocker of blockers) {
    output.write(`  ✗ ${safe(blocker.path)}: ${safe(blocker.reason)}\n`);
  }
}
