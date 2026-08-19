import type { CheckDiagnostic } from "@tryaura/core";

import { guidedNotice } from "./fix-report.js";
import type { FixOutcome, FixRequest } from "./fix.js";
import { renderManualSteps } from "./preview-render.js";
import type { DiagnosticSource } from "./report.js";

interface FixlessOutcome {
  readonly manualSteps: readonly string[];
  readonly message: string;
  /** Guided findings this run never put a question about, so it can say what it left. */
  readonly unasked: number;
}

/**
 * Ends a run that wrote nothing, saying what it left rather than only what it could not do.
 *
 * A run that may not ask its guided questions has fixes it never attempted, and reporting those as
 * unavailable would contradict the report printed directly below it.
 */
export function finishWithoutFixes(
  request: FixRequest,
  diagnostics: readonly CheckDiagnostic[],
  fixDiagnostics: readonly DiagnosticSource[],
  outcome: FixlessOutcome,
): FixOutcome {
  request.stdout.write(outcome.message);
  renderManualSteps(outcome.manualSteps, request.stdout);
  if (outcome.unasked > 0) {
    request.stdout.write(guidedNotice(request.branding, outcome.unasked));
  }
  return { applied: false, diagnostics, fixDiagnostics, fixes: [] };
}
