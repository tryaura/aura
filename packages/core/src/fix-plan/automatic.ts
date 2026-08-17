import type { Check, Finding, FixPlan, WorkspaceModel } from "@tryaura/aura-sdk";

import type { CheckDiagnostic } from "../checks.js";
import { pluralize } from "../pluralize.js";
import { describeFailure } from "../workspace/diagnostics.js";

import { prepareFixPlan, type PreparedFixPlan, preparedPreviewIndexes } from "./execute.js";

/** One finding together with the plan its check produced. */
export interface FixCandidate {
  readonly checkId: string;
  readonly findingId: string;
  readonly plan: FixPlan;
}

export interface AutomaticFixOptions {
  readonly checks: readonly Check[];
  readonly findings: readonly Finding[];
  readonly model: WorkspaceModel;
}

/**
 * Selected candidates and the single transaction they were merged into.
 *
 * A union rather than one shape with optional members: write coalescing broke the old assumption
 * that previews line up positionally with `candidate.plan.operations`, so a caller that has a
 * `prepared` plan must read `operationPreviewIndexes` to know which preview belongs to which
 * candidate. Pairing the two makes the alternative — a plan with no attribution to read — not
 * expressible.
 */
export type PreparedFixCandidates =
  | {
      readonly candidates: readonly FixCandidate[];
      readonly manualSteps: readonly string[];
      readonly operationPreviewIndexes?: undefined;
      readonly prepared?: undefined;
    }
  | {
      readonly candidates: readonly FixCandidate[];
      readonly manualSteps: readonly string[];
      /** Physical preview indexes attributed to each candidate after write coalescing. */
      readonly operationPreviewIndexes: readonly (readonly number[])[];
      readonly prepared: PreparedFixPlan;
    };

export type AutomaticFixes = PreparedFixCandidates & {
  readonly diagnostics: readonly CheckDiagnostic[];
};

export interface AutomaticFixCandidates {
  readonly candidates: readonly FixCandidate[];
  readonly diagnostics: readonly CheckDiagnostic[];
}

/** Builds per-finding plans only for checks that promise a complete automatic remediation. */
export function collectAutomaticFixCandidates(
  options: AutomaticFixOptions,
): AutomaticFixCandidates {
  const checks = new Map(options.checks.map((check) => [check.id, check]));
  const diagnostics: CheckDiagnostic[] = [];
  const candidates: FixCandidate[] = [];

  for (const finding of options.findings) {
    const check = checks.get(finding.checkId);
    if (check?.fixability !== "auto" || finding.fixability === "manual") {
      continue;
    }

    try {
      const plan = check.fix(finding, options.model);
      if (plan !== undefined) {
        candidates.push({ checkId: check.id, findingId: finding.id, plan });
      }
    } catch (error) {
      diagnostics.push({
        checkId: check.id,
        detail: describeFailure(error),
        message: `${check.id} failed while building a fix for "${finding.id}". Nothing it asked for was applied.`,
      });
    }
  }

  return Object.freeze({
    candidates: Object.freeze(candidates),
    diagnostics: Object.freeze(diagnostics),
  });
}

/** Builds and merges automatic plans for callers that do not need per-finding selection. */
export async function prepareAutomaticFixes(options: AutomaticFixOptions): Promise<AutomaticFixes> {
  const collected = collectAutomaticFixCandidates(options);
  const prepared = await prepareFixCandidates({
    candidates: collected.candidates,
    model: options.model,
  });
  return Object.freeze({ ...prepared, diagnostics: collected.diagnostics });
}

/** Merges selected per-finding plans into the single transaction the kernel will apply. */
export async function prepareFixCandidates(options: {
  readonly candidates: readonly FixCandidate[];
  readonly model: WorkspaceModel;
}): Promise<PreparedFixCandidates> {
  const candidates = Object.freeze([...options.candidates]);
  const manualSteps = Object.freeze([
    ...new Set(candidates.flatMap((candidate) => candidate.plan.manualSteps ?? [])),
  ]);
  const operations = candidates.flatMap((candidate) => candidate.plan.operations);
  if (operations.length === 0) {
    return Object.freeze({ candidates, manualSteps });
  }

  const prepared = await prepareFixPlan({
    model: options.model,
    plan: {
      manualSteps: [...manualSteps],
      operations,
      summary: `Apply ${String(candidates.length)} ${pluralize(candidates.length, "fix", "fixes")}.`,
    },
  });
  const previewIndexes = preparedPreviewIndexes(prepared);
  let sourceOperationIndex = 0;
  const operationPreviewIndexes = candidates.map((candidate) =>
    Object.freeze(
      candidate.plan.operations.flatMap(() => {
        const previewIndex = previewIndexes[sourceOperationIndex];
        sourceOperationIndex += 1;
        return previewIndex === undefined ? [] : [previewIndex];
      }),
    ),
  );

  return Object.freeze({
    candidates,
    manualSteps,
    operationPreviewIndexes: Object.freeze(operationPreviewIndexes),
    prepared,
  });
}
