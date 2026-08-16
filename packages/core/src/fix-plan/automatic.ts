import type { Check, Finding, FixPlan, WorkspaceModel } from "@tryaura/aura-sdk";

import type { CheckDiagnostic } from "../checks.js";
import { describeFailure } from "../workspace/diagnostics.js";

import { prepareFixPlan, type PreparedFixPlan } from "./execute.js";

/** Everything {@link prepareAutomaticFixes} needs to turn a check run into one plan. */
export interface AutomaticFixOptions {
  /** The same registry {@link runChecks} was given, so a finding can be traced to its check. */
  readonly checks: readonly Check[];
  readonly findings: readonly Finding[];
  readonly model: WorkspaceModel;
}

/** One merged remediation for everything the checks reported, rendered but not applied. */
export interface AutomaticFixes {
  /** Checks that threw while building a remediation. Empty on a clean run. */
  readonly diagnostics: readonly CheckDiagnostic[];
  /** Steps the plan cannot perform, gathered across every contributing check. */
  readonly manualSteps: readonly string[];
  /** Absent when no check produced an operation, which is not an error. */
  readonly prepared?: PreparedFixPlan | undefined;
}

/**
 * Collects every fixable finding's remediation into one plan and renders it.
 *
 * Every `fix` call is guarded, for the same reason {@link runChecks} guards `detect`: a check that
 * throws while building its remediation must be named, not left to surface as an anonymous CLI
 * failure that blames the whole run. The surviving checks still get their fixes.
 *
 * One plan rather than one per check, because the kernel applies a plan whole or not at all — two
 * plans could leave the machine in a state neither check expected, and a single undo entry covers
 * what one command changed.
 */
export async function prepareAutomaticFixes(options: AutomaticFixOptions): Promise<AutomaticFixes> {
  const checks = new Map(options.checks.map((check) => [check.id, check]));
  const diagnostics: CheckDiagnostic[] = [];
  const plans: FixPlan[] = [];

  for (const finding of options.findings) {
    const check = checks.get(finding.checkId);
    if (check === undefined || check.fixability === "manual") {
      continue;
    }

    try {
      // `fix` is declared on every non-manual check, but `readonly` is erased at runtime: a plugin
      // that declares itself fixable without supplying one throws here like any other failure.
      const plan = check.fix(finding, options.model);
      if (plan !== undefined) {
        plans.push(plan);
      }
    } catch (error) {
      diagnostics.push({
        checkId: check.id,
        detail: describeFailure(error),
        message: `${check.id} failed while building a fix for "${finding.id}". Nothing it asked for was applied.`,
      });
    }
  }

  const manualSteps = Object.freeze([...new Set(plans.flatMap((plan) => plan.manualSteps ?? []))]);
  const operations = plans.flatMap((plan) => plan.operations);
  if (operations.length === 0) {
    return Object.freeze({
      diagnostics: Object.freeze(diagnostics),
      manualSteps,
    });
  }

  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    manualSteps,
    prepared: await prepareFixPlan({
      model: options.model,
      plan: {
        manualSteps: [...manualSteps],
        operations,
        summary: `Apply ${String(plans.length)} fix(es).`,
      },
    }),
  });
}
