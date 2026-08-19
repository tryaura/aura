import {
  createLimiter,
  describeFailure,
  prepareFixCandidates,
  type FixCandidate,
} from "@tryaura/core";
import type { Check, Finding, FixPlan, GuidedFixChoice, WorkspaceModel } from "@tryaura/aura-sdk";

import type { FixRequest } from "./fix.js";
import type { DiagnosticSource } from "./report.js";
import { selectedValues, type WizardIo, type WizardOption } from "./setup/wizard-types.js";

/** Keeps simultaneous path probes and retained preview buffers within a small fixed ceiling. */
const MAX_CONCURRENT_GUIDED_PREVIEWS = 4;

// fallow-ignore-next-line complexity -- each branch is one explicit wizard outcome or diagnostic.
export async function gatherGuidedFixes(
  request: FixRequest,
  wizard: WizardIo,
  diagnostics: DiagnosticSource[],
): Promise<readonly FixCandidate[] | "aborted"> {
  const checks = new Map(request.checks.map((check) => [check.id, check]));
  const limitPreview = createLimiter(MAX_CONCURRENT_GUIDED_PREVIEWS);
  const selected: FixCandidate[] = [];
  const presented = new Set<FixPlan>();

  for (const [index, finding] of request.findings.entries()) {
    const check = checks.get(finding.checkId);
    // A finding may downgrade its check's fixability, and the report already renders it under
    // manual attention when it does. Asking about it here would offer in the wizard exactly what
    // the report said could not be offered.
    if (check?.fixability !== "guided" || finding.fixability === "manual") {
      continue;
    }

    let choices: readonly GuidedFixChoice[];
    try {
      choices = guidedChoices(check, finding, request.model);
    } catch (error) {
      diagnostics.push({
        detail: describeFailure(error),
        id: check.id,
        message: `${check.id} failed while building guided choices for "${finding.id}".`,
        phase: "fix",
      });
      continue;
    }
    // A check may hand several findings the very same plan object — MCP-004 rewrites a whole file,
    // so every credential in it shares one plan. Asking again would collect an answer the first
    // one already gave, and put the same file in the preview once per finding.
    if (choices.every((choice) => presented.has(choice.plan))) {
      continue;
    }
    for (const choice of choices) {
      presented.add(choice.plan);
    }

    // Concurrent on purpose: every choice is an independent preview of the same untouched
    // filesystem, and each one costs a path-policy probe, a read per target, and a rendered diff.
    // Awaiting them in turn made the wait before a question scale with the number of answers.
    const previewed = await Promise.all(
      choices.map((choice, choiceIndex) =>
        limitPreview(async () => {
          try {
            return { option: await guidedOption(check, finding, choice, choiceIndex, request) };
          } catch (error) {
            return { choice, error };
          }
        }),
      ),
    );
    const options: WizardOption[] = [];
    for (const outcome of previewed) {
      if ("option" in outcome) {
        options.push(outcome.option);
        continue;
      }
      diagnostics.push({
        detail: describeFailure(outcome.error),
        id: check.id,
        message: `${check.id} failed while previewing guided choice "${outcome.choice.id}" for "${finding.id}".`,
        phase: "fix",
      });
    }
    const result = await wizard.ask([
      {
        id: `guided-${String(index)}`,
        kind: "select",
        label: check.id,
        options: [...options, { label: "Skip", value: "skip" }],
        prompt: `[${check.id}] ${finding.message}`,
      },
    ]);
    if (result === "aborted") {
      return "aborted";
    }
    if (result === "back") {
      // Unreachable — these forms carry no flow context, so ← cannot back out of them.
      continue;
    }
    const answer = selectedValues(result[`guided-${String(index)}`])[0];
    if (answer === undefined || answer === "skip") {
      continue;
    }
    const choiceIndex = Number(answer.slice("choice:".length));
    const choice = choices[choiceIndex];
    if (choice !== undefined) {
      selected.push({ checkId: check.id, findingId: finding.id, plan: choice.plan });
    }
  }

  return Object.freeze(selected);
}

/** How many findings a run would have to ask about before it could fix them. */
export function guidedFindingCount(checks: readonly Check[], findings: readonly Finding[]): number {
  const guided = new Set(
    checks.filter((check) => check.fixability === "guided").map((check) => check.id),
  );
  return findings.filter(
    (finding) => guided.has(finding.checkId) && finding.fixability !== "manual",
  ).length;
}

export function orderCandidates(
  candidates: readonly FixCandidate[],
  findings: readonly Finding[],
): FixCandidate[] {
  const order = new Map(
    findings.map((finding, index) => [`${finding.checkId}\0${finding.id}`, index]),
  );
  return [...candidates].sort(
    (left, right) =>
      (order.get(`${left.checkId}\0${left.findingId}`) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(`${right.checkId}\0${right.findingId}`) ?? Number.MAX_SAFE_INTEGER),
  );
}

function guidedChoices(
  check: Extract<Check, { readonly fixability: "guided" }>,
  finding: Finding,
  model: WorkspaceModel,
): readonly GuidedFixChoice[] {
  if (check.guidedFixes !== undefined) {
    return check.guidedFixes(finding, model);
  }
  const plan = check.fix(finding, model);
  return plan === undefined ? [] : [{ id: "suggested", label: "Use suggested resolution", plan }];
}

async function guidedOption(
  check: Check,
  finding: Finding,
  choice: GuidedFixChoice,
  choiceIndex: number,
  request: FixRequest,
): Promise<WizardOption> {
  const candidate = { checkId: check.id, findingId: finding.id, plan: choice.plan };
  const prepared = await prepareFixCandidates({ candidates: [candidate], model: request.model });
  const details = choice.details?.();
  const diffs = prepared.prepared?.preview.operations.map((operation) => operation.diff) ?? [];
  const manual = choice.plan.manualSteps ?? [];
  const preview = [
    check.explain,
    choice.plan.summary,
    ...(details === undefined ? [] : [details]),
    ...diffs,
    ...(manual.length === 0
      ? []
      : ["Steps to take yourself:", ...manual.map((step) => `- ${step}`)]),
  ].join("\n\n");
  return {
    description: choice.plan.summary,
    label: choice.label,
    preview,
    value: `choice:${String(choiceIndex)}`,
  };
}
