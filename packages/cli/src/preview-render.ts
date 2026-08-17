import type { Writable } from "node:stream";

import type { FixOperationPreview, PreparedFixPlan, prepareFixCandidates } from "@tryaura/core";
import type { Check, Finding } from "@tryaura/aura-sdk";

import { safe, safeMultiline } from "./render.js";
import type { CliBranding } from "./types.js";

/** A prepared plan that still knows which physical preview belongs to which candidate. */
type AttributedFixPlan = Extract<
  Awaited<ReturnType<typeof prepareFixCandidates>>,
  { prepared: PreparedFixPlan }
>;

/**
 * Shows what applying the plan would do; only the shape of each change unless `withDetail`.
 *
 * The preview is not positionally aligned with the candidates: coalescing lets several same-path
 * writes share one physical operation, so attribution goes through `operationPreviewIndexes` — the
 * same way the report reads it — and a shared operation prints under every check that asked for it.
 * Grouping them under the check that proposed each change is what lets the user judge the plan:
 * the findings themselves have not been printed yet at this point in the flow.
 */
export function renderFixPreview(
  plan: AttributedFixPlan,
  withDetail: boolean,
  output: Writable,
): void {
  output.write(`Fix preview: ${safe(plan.prepared.preview.summary)}\n`);
  const previews = plan.prepared.preview.operations;
  for (const [candidateIndex, candidate] of plan.candidates.entries()) {
    const operations = (plan.operationPreviewIndexes[candidateIndex] ?? []).flatMap((index) => {
      const operation = previews[index];
      return operation === undefined ? [] : [operation];
    });
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
 * Names `--interactive` when it is the thing that would have helped.
 *
 * `--fix` only builds plans for `auto` checks, so a workspace whose findings are all `guided`
 * otherwise reads as "nothing can be done" when in fact the next flag along does exactly what the
 * user asked for.
 */
export function renderGuidedHint(
  checks: readonly Check[],
  findings: readonly Finding[],
  branding: CliBranding,
  output: Writable,
): void {
  const guided = new Set(
    checks.filter((check) => check.fixability === "guided").map((check) => check.id),
  );
  if (!findings.some((finding) => guided.has(finding.checkId))) {
    return;
  }
  output.write(
    `Some of these findings offer guided resolutions. Run ${branding.command} check --fix --interactive to choose one.\n\n`,
  );
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
