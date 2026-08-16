import type { Writable } from "node:stream";

import type { FixOperationPreview } from "@tryaura/core";

import { safe, safeMultiline } from "./render.js";

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
): void {
  for (const operation of operations) {
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
