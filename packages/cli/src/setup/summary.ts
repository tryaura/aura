import type { Writable } from "node:stream";

import type { FixPlanPreview } from "@tryaura/core";

import { renderManualSteps, renderOperationPreviews } from "../preview-render.js";
import { safe } from "../safe-text.js";
import type { SetupBlocker, SetupNotice } from "./planner.js";

/** The already-converged variant of the summary: nothing to confirm, at most context to show. */
export function renderConvergedSetup(
  preview: FixPlanPreview,
  notices: readonly SetupNotice[],
  withDetail: boolean,
  output: Writable,
): void {
  output.write("\n");
  if (preview.manualSteps.length === 0 && notices.length === 0) {
    output.write("Already converged — nothing to do.\n\n");
    return;
  }
  renderSetupSummary(preview, [], notices, withDetail, output);
  output.write("\n");
}

/** Shows the whole plan — changes, blockers, manual steps — before the one confirmation. */
export function renderSetupSummary(
  preview: FixPlanPreview,
  blockers: readonly SetupBlocker[],
  notices: readonly SetupNotice[],
  withDetail: boolean,
  output: Writable,
): void {
  output.write(`Plan: ${safe(preview.summary)}\n`);

  if (preview.changedOperationCount === 0 && preview.conflictedOperationCount === 0) {
    output.write("  Nothing to change.\n");
  }
  renderOperationPreviews(preview.operations, withDetail, output);
  renderBlockers(blockers, output);
  renderNotices(notices, output);
  renderManualSteps(preview.manualSteps, output);

  if (!withDetail && preview.changedOperationCount > 0) {
    output.write("\nRe-run with --detail to see the full diff of every change.\n");
  }
}

const NOTICE_HEADINGS: Readonly<Record<SetupNotice["kind"], string>> = Object.freeze({
  overwritten: "Hand edits Aura is replacing:",
  preserved: "Preserved content Aura does not own:",
});

function renderNotices(notices: readonly SetupNotice[], output: Writable): void {
  for (const kind of ["overwritten", "preserved"] as const) {
    const matching = notices.filter((notice) => notice.kind === kind);
    if (matching.length === 0) {
      continue;
    }
    output.write(`\n${NOTICE_HEADINGS[kind]}\n`);
    for (const notice of matching) {
      output.write(`  · ${safe(notice.message)}\n`);
    }
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
