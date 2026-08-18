import type {
  AuraEffectiveConfig,
  Check,
  DetectedFinding,
  Finding,
  JsonObject,
  Severity,
  WorkspaceModel,
} from "@tryaura/aura-sdk";

import { describeFailure } from "./workspace/diagnostics.js";

/**
 * A check that could not run, reported alongside the findings the surviving checks produced.
 *
 * Shaped like {@link ScanDiagnostic} and kept separate from it for the same reason: a problem with
 * the run itself is not a finding about the machine, and must not be mistaken for one.
 */
export interface CheckDiagnostic {
  /** The {@link Check.id} that threw. */
  readonly checkId: string;
  /**
   * Verbatim text from the check that failed.
   *
   * Untrusted, and potentially secret — a check reads a model built from files that hold API
   * tokens. This is for opt-in debug output; never render it in the default report.
   */
  readonly detail?: string | undefined;
  /** One sentence naming the problem, in terms the user can act on. */
  readonly message: string;
}

/** The outcome of one check pass: what was found, and which checks could not run. */
export interface CheckRun {
  /** Checks that threw. Empty on a clean run. */
  readonly diagnostics: readonly CheckDiagnostic[];
  /** Everything the checks that did run reported. */
  readonly findings: readonly Finding[];
}

/**
 * Runs registered checks and stamps their identity onto every detected finding.
 *
 * Every check call is guarded, for the same reason every adapter call is: a check runs with the
 * full privileges of the process and is trusted to that extent, but one that throws must not cost
 * the user the findings every other check produced.
 */
export function runChecks(
  checks: readonly Check[],
  model: WorkspaceModel,
  config?: AuraEffectiveConfig,
): CheckRun {
  const diagnostics: CheckDiagnostic[] = [];
  const findings: Finding[] = [];

  for (const check of checks) {
    const detectedFindings: Finding[] = [];
    try {
      const detected = check.detect(model, { thresholds: thresholdsFor(check, config) });
      for (const finding of detected) {
        detectedFindings.push(toFinding(check, finding, config));
      }
    } catch (error) {
      diagnostics.push(failure(check, error));
      continue;
    }

    for (const finding of detectedFindings) {
      findings.push(finding);
    }
  }

  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    findings: Object.freeze(findings),
  });
}

/**
 * Projects a detected finding onto the fields a finding is made of.
 *
 * Spreading the check's object instead would carry whatever else it happened to attach straight
 * into machine-readable output: `readonly` is erased at runtime, so the declared shape is a
 * request rather than a guarantee.
 */
function toFinding(
  check: Check,
  detected: DetectedFinding,
  config: AuraEffectiveConfig | undefined,
): Finding {
  return Object.freeze({
    checkId: check.id,
    id: detected.id,
    message: detected.message,
    scope: check.scope,
    severity: severityFor(check, detected, config),
    ...(detected.details === undefined ? {} : { details: detected.details }),
    ...(detected.fixability === undefined ? {} : { fixability: detected.fixability }),
    ...(detected.locations === undefined ? {} : { locations: detected.locations }),
    ...(detected.metadata === undefined ? {} : { metadata: detected.metadata }),
    ...(detected.presentation === undefined ? {} : { presentation: detected.presentation }),
  });
}

/**
 * Resolves one finding's severity: configured override, then occurrence, then check default.
 *
 * The effective configuration always carries a severity, so the `default` layer has to be stepped
 * over explicitly. Without that, a check's own default would outrank the severity it deliberately
 * chose for a single occurrence — a transient probe failure would report as loudly as a real one.
 */
function severityFor(
  check: Check,
  detected: DetectedFinding,
  config: AuraEffectiveConfig | undefined,
): Severity {
  const configured = config?.checks[check.id]?.severity;
  if (configured !== undefined && configured.provenance.layer !== "default") {
    return configured.value;
  }
  return detected.severity ?? check.defaultSeverity;
}

function thresholdsFor(check: Check, config: AuraEffectiveConfig | undefined): JsonObject {
  return config?.checks[check.id]?.thresholds.value ?? Object.freeze({});
}

/** Records a failed check without repeating what the check said. */
function failure(check: Check, error: unknown): CheckDiagnostic {
  return {
    checkId: check.id,
    detail: describeFailure(error),
    message: `Check ${check.id} failed and was skipped. This is a bug in the check; report it to whoever ships the plugin.`,
  };
}
