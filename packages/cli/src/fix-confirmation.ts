import { isTerminal } from "./command-support.js";
import type { FixRequest } from "./fix.js";
import { createInteractiveWizardIo } from "./setup/wizard-prompt.js";
import type { WizardIo } from "./setup/wizard-types.js";

/**
 * Whether a check run would put guided questions on screen — the telemetry sense of interactive.
 *
 * `--json` promises one machine-readable document and a machine cannot answer, so that run declines
 * the questions it is otherwise able to ask.
 */
export function runAsksGuided(
  options: Pick<FixRequest, "stdin" | "stdout" | "yes"> & {
    readonly fix: boolean;
    readonly json: boolean;
  },
): boolean {
  return options.fix && !options.json && canPrompt(options, undefined);
}

/**
 * Whether this run can put a question on screen and read the answer.
 *
 * The guided step and the confirmation step ask the same thing of the same streams, so they read
 * the capability from here rather than each deciding for itself — a run that may not ask which
 * resolution to take may not ask whether to apply one either.
 */
export function canPrompt(
  request: Pick<FixRequest, "stdin" | "stdout" | "yes">,
  wizard: WizardIo | undefined,
): boolean {
  if (request.yes) {
    return false;
  }
  return wizard !== undefined || (isTerminal(request.stdin) && isTerminal(request.stdout));
}

/**
 * One confirmation idiom for every fix path.
 *
 * `check --fix` confirms through the same Apply/Cancel wizard form that setup, undo, and the guided
 * questions use, instead of presenting a second `[y/N]` dialect for the same decision. A caller
 * that already holds a wizard (the guided branch, or a test's scripted seam) keeps it; otherwise
 * one is built here — only when both streams are terminals, so non-TTY runs still report the prompt
 * unavailable rather than hanging.
 */
export async function confirmFixes(
  request: Pick<FixRequest, "colorDepth" | "stdin" | "stdout" | "yes">,
  wizard: WizardIo | undefined,
): Promise<"accepted" | "declined" | "unavailable"> {
  if (request.yes) {
    return "accepted";
  }
  if (!canPrompt(request, wizard)) {
    return "unavailable";
  }
  const io =
    wizard ??
    createInteractiveWizardIo({
      colorDepth: request.colorDepth,
      stdin: request.stdin,
      stdout: request.stdout,
    });
  const result = await io.confirm("Apply this fix plan?");
  return result === "accepted" ? "accepted" : "declined";
}
