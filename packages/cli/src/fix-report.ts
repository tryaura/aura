import type { prepareFixCandidates, FixCandidate } from "@tryaura/core";
import type { FileOperation } from "@tryaura/aura-sdk";

import type { ReportFix } from "./report.js";

/**
 * Shapes one prepared candidate per report entry, pairing each with its own rendered operations.
 *
 * The preview is not positionally aligned with the candidates: coalescing lets several same-path
 * writes share one physical operation, so two candidates can legitimately report the same preview.
 * `operationPreviewIndexes` carries that attribution. A candidate that contributes no operation is
 * left out entirely: it changed no file, and the finding it came from is still in the report to say
 * what remains.
 */
export function reportFixes(
  prepared: Awaited<ReturnType<typeof prepareFixCandidates>>,
  status: ReportFix["status"],
  withDetail: boolean,
  message?: string,
): readonly ReportFix[] {
  const previews = prepared.prepared?.preview.operations ?? [];
  return prepared.candidates.flatMap((candidate, candidateIndex) => {
    if (candidate.plan.operations.length === 0) {
      return [];
    }
    const operations = (prepared.operationPreviewIndexes?.[candidateIndex] ?? []).flatMap(
      (index) => {
        const operation = previews[index];
        return operation === undefined ? [] : [operation];
      },
    );
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
