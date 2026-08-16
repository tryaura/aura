import type { SetupStep } from "../types.js";
import { appsStep } from "./apps.js";
import { baselineStep } from "./baseline.js";
import { instructionsStep } from "./instructions.js";

/**
 * Every setup step, in the order the wizard runs them.
 *
 * A plain list on purpose: AURA-30's `--add <step>` runs a subset of it by id, and later steps
 * (instructions, MCP) register here without the runner changing.
 */
export const SETUP_STEPS: readonly SetupStep[] = Object.freeze([
  appsStep,
  instructionsStep,
  baselineStep,
]);
