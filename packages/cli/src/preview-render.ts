import type { Writable } from "node:stream";

import type { FixOperationPreview, PreparedFixPlan, prepareFixCandidates } from "@tryaura/core";

import { operationsForCandidate } from "./fix-report.js";
import { safe, safeMultiline } from "./safe-text.js";

/** A prepared plan that still knows which physical preview belongs to which candidate. */
type AttributedFixPlan = Extract<
  Awaited<ReturnType<typeof prepareFixCandidates>>,
  { prepared: PreparedFixPlan }
>;

/**
 * Shows what applying the plan would do; only the shape of each change unless `withDetail`.
 *
 * Attribution goes through {@link operationsForCandidate} — the same way the report reads it — so
 * a coalesced operation prints under every check that asked for it. Grouping them under the check
 * that proposed each change is what lets the user judge the plan: the findings themselves have not
 * been printed yet at this point in the flow.
 */
export function renderFixPreview(
  plan: AttributedFixPlan,
  withDetail: boolean,
  output: Writable,
): void {
  output.write(`Fix preview: ${safe(plan.prepared.preview.summary)}\n`);
  for (const [candidateIndex, candidate] of plan.candidates.entries()) {
    const operations = operationsForCandidate(plan, candidateIndex);
    if (operations.every((operation) => operation.effect === "noop")) {
      continue;
    }
    output.write(`  [${safe(candidate.checkId)}] ${safe(candidate.plan.summary)}\n`);
    renderOperationPreviews(operations, withDetail, output, "    ");
  }
  if (!withDetail) {
    output.write("\nRe-run with --detail to see the full diff of every change.\n");
  }
  renderManualSteps(plan.manualSteps, output);
}

/**
 * Prints the shape of each changed operation, one line per change.
 *
 * The diffs only under `withDetail`: a diff quotes the file it rewrites, and an instruction file is
 * exactly the kind of place a user pastes an API token, so the contents sit behind the same
 * `--detail` flag that gates a plugin's own error text.
 */
export function renderOperationPreviews(
  operations: readonly FixOperationPreview[],
  withDetail: boolean,
  output: Writable,
  indent = "  ",
): void {
  for (const operation of operations) {
    if (operation.effect === "noop") {
      continue;
    }

    output.write(`${indent}${operation.effect} ${operation.paths.map(safe).join(" -> ")}\n`);
    if (operation.conflict !== undefined) {
      output.write(`${indent}  blocked: ${safe(operation.conflict)}\n`);
    }
    if (withDetail) {
      output.write(`\n${safeMultiline(operation.diff)}\n`);
    }
  }
}

/** Prints what the plan cannot do for the user, which is otherwise lost between preview and report. */
export function renderManualSteps(steps: readonly string[], output: Writable): void {
  if (steps.length === 0) {
    return;
  }

  output.write("\nSteps to take yourself:\n");
  for (const step of steps) {
    output.write(`  - ${safe(step)}\n`);
  }
}
