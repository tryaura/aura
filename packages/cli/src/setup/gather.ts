import {
  SETUP_ABORTED,
  SETUP_BACK,
  type GatheredSetup,
  type SetupSelections,
  type SetupStep,
  type SetupStepContext,
  type SetupStepUnoffered,
  type SetupTelemetryCategory,
} from "./types.js";
import type { WizardFlowContext, WizardFlowStep, WizardIo } from "./wizard-types.js";

type GatherSelectionsResult =
  | { readonly status: "aborted" }
  | {
      readonly missing: string;
      readonly status: "invalid-dependency";
      readonly stepTitle: string;
    }
  | (GatheredSetup & { readonly status: "ready" });

/**
 * Where a gather pass starts: step index plus everything the passes before it settled.
 *
 * A pass can open on the last step alone, so what was offered accumulates across passes exactly as
 * the selections do; rebuilding it per pass would forget every earlier step.
 */
export interface GatherStart extends GatheredSetup {
  /** Set when the pass opens by backing into its first step, e.g. from the confirmation. */
  readonly entered?: "backward" | undefined;
  readonly index: number;
}

export async function gatherSelections(
  steps: readonly SetupStep[],
  context: Omit<SetupStepContext, "selections">,
  io: WizardIo,
  start: GatherStart,
): Promise<GatherSelectionsResult> {
  const flowSteps = steps.map(toFlowStep);
  const offeredCategories = new Set<SetupTelemetryCategory>(start.offered);
  let selections = start.selections;
  // Steps before the start index completed in an earlier pass of this same run.
  const completedSteps = new Set(steps.slice(0, start.index).map((step) => step.id));
  // A pass that starts mid-flow got there by finishing every step once already.
  const visited = new Set(
    steps.slice(0, start.index === 0 ? 0 : start.index + 1).map((step) => step.id),
  );
  let index = start.index;
  let enteredBackward = start.entered === "backward";
  while (index < steps.length) {
    const step = steps[index];
    if (step === undefined) {
      break;
    }
    const flow: WizardFlowContext = {
      completed: flowSteps.slice(0, index),
      step: toFlowStep(step),
      upcoming: flowSteps.slice(index + 1),
    };
    const stepContext: SetupStepContext = {
      ...context,
      enteredBackward,
      flow,
      revisited: visited.has(step.id),
      selections,
    };
    const prerequisite = step.prerequisites?.find(
      (candidate) => !completedSteps.has(candidate.id) && !candidate.isSatisfied(stepContext),
    );
    if (prerequisite !== undefined) {
      return {
        missing: prerequisite.title,
        status: "invalid-dependency",
        stepTitle: step.title,
      };
    }
    visited.add(step.id);
    const outcome = await step.gather(stepContext, withFlow(io, flow));
    if (outcome === SETUP_ABORTED) {
      return { status: "aborted" };
    }
    if (outcome === SETUP_BACK) {
      // At the first step there is nowhere left to go; it simply reopens, facing forward.
      enteredBackward = index > 0;
      index = Math.max(0, index - 1);
      continue;
    }
    const settled = readStepOutcome(outcome);
    selections = settled.selections;
    trackOffered(offeredCategories, step, settled.offered);
    completedSteps.add(step.id);
    enteredBackward = false;
    index += 1;
  }
  return { offered: offeredCategories, selections, status: "ready" };
}

/**
 * Records whether this visit put the step's telemetry category on screen.
 *
 * A revisit re-decides it in both directions: the step is the only thing that knows whether it had
 * anything to ask this time, and the answer can differ once an earlier step changed what it draws
 * from — an Apps answer that drops every skills-capable application, for one.
 */
function trackOffered(
  categories: Set<SetupTelemetryCategory>,
  step: SetupStep,
  offered: boolean,
): void {
  if (step.telemetryCategory === undefined) {
    return;
  }
  if (offered) {
    categories.add(step.telemetryCategory);
  } else {
    categories.delete(step.telemetryCategory);
  }
}

/** Splits a completed step's outcome into what it settled and whether it asked anything to do it. */
export function readStepOutcome(outcome: SetupSelections | SetupStepUnoffered): {
  readonly offered: boolean;
  readonly selections: SetupSelections;
} {
  return "unoffered" in outcome
    ? { offered: false, selections: outcome.selections }
    : { offered: true, selections: outcome };
}

export function toFlowStep(step: SetupStep): WizardFlowStep {
  return { compactLabel: step.compactTitle, label: step.title };
}

/**
 * Injects the flow position into every form a step opens, so its tab bar maps the whole wizard.
 *
 * Confirms stay untouched: a mid-step confirm is a modal stop, not a step of the flow.
 */
function withFlow(io: WizardIo, flow: WizardFlowContext): WizardIo {
  return {
    ...io,
    ask: async (questions, override) => io.ask(questions, override ?? flow),
    load: async (request, task, override) => io.load(request, task, override ?? flow),
  };
}
