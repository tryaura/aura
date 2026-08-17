import type { ScanDiagnostic } from "./diagnostics.js";

/** One resolved registry contribution, or the diagnostic saying why there is none. */
export type ResolutionOutcome<T> =
  | { readonly diagnostic: ScanDiagnostic; readonly kind: "failed" }
  | { readonly kind: "resolved"; readonly value: T };

/** A contribution kind's resolved entries alongside the failures that produced no entry. */
export interface Resolution<T> {
  readonly diagnostics: readonly ScanDiagnostic[];
  readonly values: readonly T[];
}

/**
 * Splits resolution outcomes into what the model gets and what the report gets.
 *
 * Every registry contribution backed by a bundled file resolves the same way: a failure drops the
 * entry and names it rather than failing the scan, because a partial model is easier to act on
 * than no model at all.
 */
export function partitionResolutions<T>(outcomes: readonly ResolutionOutcome<T>[]): Resolution<T> {
  return Object.freeze({
    diagnostics: Object.freeze(
      outcomes.filter((outcome) => outcome.kind === "failed").map((outcome) => outcome.diagnostic),
    ),
    values: Object.freeze(
      outcomes.filter((outcome) => outcome.kind === "resolved").map((outcome) => outcome.value),
    ),
  });
}

/** Records why one contribution produced no entry, under the core-owned id that stands in for it. */
export function failedResolution<T>(
  adapterId: string,
  message: string,
  phase: ScanDiagnostic["phase"],
  path?: string,
): ResolutionOutcome<T> {
  return {
    diagnostic: {
      adapterId,
      message,
      ...(path === undefined ? {} : { path }),
      phase,
    },
    kind: "failed",
  };
}
