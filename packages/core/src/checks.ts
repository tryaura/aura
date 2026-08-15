import type { Check, Finding, WorkspaceModel } from "@tryaura/aura-sdk";

/** Runs registered checks and stamps their identity onto every detected finding. */
export function runChecks(checks: readonly Check[], model: WorkspaceModel): readonly Finding[] {
  const findings: Finding[] = [];

  for (const check of checks) {
    for (const detected of check.detect(model)) {
      findings.push(
        Object.freeze({
          ...detected,
          checkId: check.id,
          scope: check.scope,
          severity: detected.severity ?? check.defaultSeverity,
        }),
      );
    }
  }

  return Object.freeze(findings);
}
