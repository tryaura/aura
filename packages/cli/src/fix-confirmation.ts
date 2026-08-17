import { isTerminal } from "./command-support.js";
import type { FixRequest } from "./fix.js";
import { createInteractiveWizardIo } from "./setup/wizard-prompt.js";
import type { WizardIo } from "./setup/wizard-types.js";

/**
 * One confirmation idiom for every fix path.
 *
 * A plain `check --fix` confirms through the same Apply/Cancel wizard form that setup, undo, and
 * `--fix --interactive` use, instead of presenting a second `[y/N]` dialect for the same decision.
 * A caller that already holds a wizard (the interactive branch, or a test's scripted seam) keeps
 * it; otherwise one is built here — only when both streams are terminals, so non-TTY runs still
 * report the prompt unavailable rather than hanging.
 */
export async function confirmFixes(
  request: Pick<FixRequest, "colorDepth" | "stdin" | "stdout" | "yes">,
  wizard: WizardIo | undefined,
): Promise<"accepted" | "declined" | "unavailable"> {
  if (request.yes) {
    return "accepted";
  }
  if (wizard === undefined && (!isTerminal(request.stdin) || !isTerminal(request.stdout))) {
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
