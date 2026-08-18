import type { FixOutcome } from "./fix.js";
import type { DiagnosticSource } from "./report.js";

/**
 * Flattens one fix pass into the report's diagnostic shape.
 *
 * A fix run produces two streams — checks that failed while building their remediation, and the
 * plan's own problems — and the report treats both as one `fix` phase. Merging them here keeps
 * the check command's lifecycle readable as a sequence rather than a shape conversion.
 */
export function fixPassDiagnostics(outcome: FixOutcome): readonly DiagnosticSource[] {
  return [
    ...outcome.diagnostics.map((diagnostic): DiagnosticSource => ({
      detail: diagnostic.detail,
      id: diagnostic.checkId,
      message: diagnostic.message,
      phase: "fix",
    })),
    ...outcome.fixDiagnostics,
  ];
}
