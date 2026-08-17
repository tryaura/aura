import { describeFailure, prepareFixCandidates, type FixCandidate } from "@tryaura/core";
import type { Check, Finding, GuidedFixChoice, WorkspaceModel } from "@tryaura/aura-sdk";

import type { FixRequest } from "./fix.js";
import type { DiagnosticSource } from "./report.js";
import { selectedValues, type WizardIo, type WizardOption } from "./setup/wizard-types.js";

// fallow-ignore-next-line complexity -- each branch is one explicit wizard outcome or diagnostic.
export async function gatherGuidedFixes(
  request: FixRequest,
  wizard: WizardIo,
  diagnostics: DiagnosticSource[],
): Promise<readonly FixCandidate[] | "aborted"> {
  const checks = new Map(request.checks.map((check) => [check.id, check]));
  const selected: FixCandidate[] = [];

  for (const [index, finding] of request.findings.entries()) {
    const check = checks.get(finding.checkId);
    if (check?.fixability !== "guided") {
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
    if (choices.length === 0) {
      continue;
    }

    // Concurrent on purpose: every choice is an independent preview of the same untouched
    // filesystem, and each one costs a path-policy probe, a read per target, and a rendered diff.
    // Awaiting them in turn made the wait before a question scale with the number of answers.
    const previewed = await Promise.all(
      choices.map(async (choice, choiceIndex) => {
        try {
          return { option: await guidedOption(check, finding, choice, choiceIndex, request) };
        } catch (error) {
          return { choice, error };
        }
      }),
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
