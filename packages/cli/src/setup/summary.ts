import type { Writable } from "node:stream";

import type { FixPlanPreview } from "@tryaura/core";

import { safe, safeMultiline } from "../render.js";
import type { SetupBlocker } from "./planner.js";

/**
 * Shows the whole plan before the one confirmation.
 *
 * The shape of each change by default; the diffs only under `--detail`, because they quote the
 * files being rewritten and an instruction file is exactly where a user pastes an API token — the
 * same gate `check --fix` applies.
 */
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
  for (const operation of preview.operations) {
    if (operation.effect === "noop") {
      continue;
    }
    output.write(`  ${operation.effect} ${operation.paths.map(safe).join(" -> ")}\n`);
    if (operation.conflict !== undefined) {
      output.write(`    blocked: ${safe(operation.conflict)}\n`);
    }
    if (withDetail) {
      output.write(`\n${safeMultiline(operation.diff)}\n`);
    }
  }

  if (blockers.length > 0) {
    output.write("\nBlocked, and left out of the plan:\n");
    for (const blocker of blockers) {
      output.write(`  ✗ ${safe(blocker.path)}: ${safe(blocker.reason)}\n`);
    }
  }

  if (preview.manualSteps.length > 0) {
    output.write("\nSteps to take yourself:\n");
    for (const step of preview.manualSteps) {
      output.write(`  - ${safe(step)}\n`);
    }
  }

  if (!withDetail && preview.changedOperationCount > 0) {
    output.write("\nRe-run with --detail to see the full diff of every change.\n");
  }
}
