import type { Finding, FixPlan } from "@tryaura/aura-sdk";

import type { FailureKind } from "./links.js";

/**
 * Turns one finding into the manual repair it calls for.
 *
 * Every INS-006 problem is a decision about what the user meant, so the plan carries steps and no
 * operations: Aura can say which reference is wrong, never which of create, correct, and remove was
 * intended.
 */
export function guidedFix(finding: Finding): FixPlan | undefined {
  const failure = finding.metadata?.["failure"];
  if (!isFailureKind(failure)) {
    return undefined;
  }
  const step = overflowManualStep(finding) ?? MANUAL_STEPS[failure](finding);
  if (step === undefined) {
    return undefined;
  }
  return {
    manualSteps: [step, "Run `aura check` again after updating the instruction files."],
    operations: [],
    summary: `Repair the ${failure} instruction-link problem.`,
  };
}

const MANUAL_STEPS: Readonly<Record<FailureKind, (finding: Finding) => string | undefined>> = {
  cycle: () => "Remove or redirect at least one import shown in the cycle.",
  depth: () =>
    "Flatten the imported guidance or shorten the chain to the application's supported depth.",
  missing: missingManualStep,
  outside: outsideManualStep,
  unsupported: unsupportedManualStep,
};

function missingManualStep(finding: Finding): string | undefined {
  const sourcePath = finding.metadata?.["sourcePath"];
  const targetPath = finding.metadata?.["targetPath"];
  return typeof sourcePath === "string" && typeof targetPath === "string"
    ? `Create ${targetPath}, correct its path in ${sourcePath}, or remove the reference.`
    : undefined;
}

function overflowManualStep(finding: Finding): string | undefined {
  const sourcePath = finding.metadata?.["sourcePath"];
  return typeof sourcePath === "string" && typeof finding.metadata?.["hidden"] === "number"
    ? `Fix the reported link problems in ${sourcePath}, then run the check again to reveal the rest.`
    : undefined;
}

function outsideManualStep(finding: Finding): string | undefined {
  const sourcePath = finding.metadata?.["sourcePath"];
  return typeof sourcePath === "string"
    ? `Point the reference in ${sourcePath} inside the project, or remove it.`
    : undefined;
}

function unsupportedManualStep(finding: Finding): string | undefined {
  const sourcePath = finding.metadata?.["sourcePath"];
  return typeof sourcePath === "string"
    ? `Remove the unsupported import from ${sourcePath} or use the application's native instruction mechanism.`
    : undefined;
}

function isFailureKind(value: unknown): value is FailureKind {
  return (
    value === "cycle" ||
    value === "depth" ||
    value === "missing" ||
    value === "outside" ||
    value === "unsupported"
  );
}
