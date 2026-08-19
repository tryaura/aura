import type { prepareFixCandidates, FixCandidate, FixOperationPreview } from "@tryaura/core";
import { pluralize } from "@tryaura/core/pluralize";
import type { FileOperation } from "@tryaura/aura-sdk";

import type { ReportFix } from "./report.js";
import type { CliBranding } from "./types.js";

/**
 * The physical preview operations one candidate contributed to a prepared plan.
 *
 * The preview is not positionally aligned with the candidates: coalescing lets several same-path
 * writes share one physical operation, so two candidates can legitimately report the same preview.
 * `operationPreviewIndexes` carries that attribution, and this is the one place that reads it —
 * the report and the preview renderer must never disagree about which operation belongs to whom.
 */
export function operationsForCandidate(
  plan: Awaited<ReturnType<typeof prepareFixCandidates>>,
  candidateIndex: number,
): readonly FixOperationPreview[] {
  const previews = plan.prepared?.preview.operations ?? [];
  return (plan.operationPreviewIndexes?.[candidateIndex] ?? []).flatMap((index) => {
    const operation = previews[index];
    return operation === undefined ? [] : [operation];
  });
}

/**
 * Shapes one prepared candidate per report entry, pairing each with its own rendered operations.
 *
 * A candidate that contributes no operation is left out entirely: it changed no file, and the
 * finding it came from is still in the report to say what remains.
 */
export function reportFixes(
  prepared: Awaited<ReturnType<typeof prepareFixCandidates>>,
  status: ReportFix["status"],
  withDetail: boolean,
  message?: string,
): readonly ReportFix[] {
  return prepared.candidates.flatMap((candidate, candidateIndex) => {
    if (candidate.plan.operations.length === 0) {
      return [];
    }
    const operations = operationsForCandidate(prepared, candidateIndex);
    return [
      Object.freeze({
        checkId: candidate.checkId,
        findingId: candidate.findingId,
        manualSteps: Object.freeze([...(candidate.plan.manualSteps ?? [])]),
        ...(message === undefined ? {} : { message }),
        operations: Object.freeze(
          operations.map((operation) =>
            Object.freeze({
              ...(operation.conflict === undefined ? {} : { conflict: operation.conflict }),
              ...(withDetail ? { diff: operation.diff } : {}),
              effect: operation.effect,
              paths: Object.freeze([...operation.paths]),
            }),
          ),
        ),
        status,
        summary: candidate.plan.summary,
      }),
    ];
  });
}

/**
 * What a run that prepared no plan says it did.
 *
 * Candidates survive the preparation only when their plan does something, so candidates without a
 * single operation are plans made entirely of steps the user has to take. Reporting those as no
 * available fix contradicts the choice the user just made and hides the steps below it.
 *
 * `unasked` guided findings get no message at all here: {@link guidedNotice} is the whole sentence
 * for that run, and "no executable fixes are available" would deny the findings it is about to name.
 */
export function fixlessMessage(candidates: number, findings: number, unasked: number): string {
  if (candidates > 0) {
    return "Nothing to write: what these fixes need is listed below.\n\n";
  }
  if (findings === 0) {
    return "Nothing to fix.\n\n";
  }
  return unasked > 0 ? "" : "No executable fixes are available for the findings below.\n\n";
}

/**
 * Why a run that cannot ask questions left the guided fixes where they were.
 *
 * Every route to this sentence is one the user chose — `--yes`, `--json`, or a shell with no
 * terminal — so it names them rather than describing the run's state back at them.
 */
export function guidedNotice(branding: CliBranding, unasked: number): string {
  return `Left ${String(unasked)} guided ${pluralize(unasked, "finding", "findings")} alone: this run cannot ask for the choices they need. Run ${branding.command} check --fix in a terminal, without --yes or --json.\n\n`;
}

export function reportUnpreparedFixes(candidates: readonly FixCandidate[]): readonly ReportFix[] {
  return candidates.flatMap((candidate): readonly ReportFix[] => {
    if (candidate.plan.operations.length === 0) {
      return [];
    }
    return [
      Object.freeze({
        checkId: candidate.checkId,
        findingId: candidate.findingId,
        manualSteps: Object.freeze([...(candidate.plan.manualSteps ?? [])]),
        message: "The combined plan could not be prepared.",
        operations: Object.freeze(candidate.plan.operations.map(failedOperation)),
        status: "failed",
        summary: candidate.plan.summary,
      }),
    ];
  });
}

function failedOperation(operation: FileOperation): ReportFix["operations"][number] {
  return Object.freeze({
    conflict: "The combined plan could not be prepared.",
    effect: "conflict",
    paths: Object.freeze(operationPaths(operation)),
  });
}

function operationPaths(operation: FileOperation): string[] {
  if (operation.type === "move") {
    return [operation.sourcePath, operation.destinationPath];
  }
  return [operation.path];
}
