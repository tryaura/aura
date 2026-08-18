import type { SetupStep } from "../types.js";
import { appsStep } from "./apps.js";
import { baselineStep } from "./baseline.js";
import { instructionsStep } from "./instructions.js";
import { skillsStep } from "./skills.js";
import { snippetsStep } from "./snippets.js";

/**
 * Every setup step, in the order the wizard runs them.
 *
 * A plain list on purpose: `--add <step>` runs a subset of it by id, and later steps
 * (instructions, MCP) register here without the runner changing.
 */
export const SETUP_STEPS: readonly SetupStep[] = Object.freeze([
  appsStep,
  instructionsStep,
  snippetsStep,
  skillsStep,
  baselineStep,
]);

export type SetupStepSelection =
  /** Carries the rejected kind, so the caller renders the message without reading argv again. */
  | { readonly kind: string; readonly status: "invalid"; readonly validKinds: readonly string[] }
  | { readonly status: "ready"; readonly steps: readonly SetupStep[] };

/** Every kind `--add` accepts, in registry order. */
export function setupAddKinds(): readonly string[] {
  return SETUP_STEPS.flatMap((candidate) =>
    candidate.addKind === undefined ? [] : [candidate.addKind],
  );
}

/** Resolves a public `--add` kind from the registry without teaching the command about step ids. */
export function selectSetupSteps(addKind: string | undefined): SetupStepSelection {
  if (addKind === undefined) {
    return { status: "ready", steps: SETUP_STEPS };
  }

  const step = SETUP_STEPS.find((candidate) => candidate.addKind === addKind);
  if (step !== undefined) {
    return { status: "ready", steps: [step] };
  }

  return { kind: addKind, status: "invalid", validKinds: setupAddKinds() };
}
