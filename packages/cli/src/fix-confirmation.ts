import { createInterface } from "node:readline/promises";

import { isTerminal } from "./command-support.js";
import type { FixRequest } from "./fix.js";
import type { WizardIo } from "./setup/wizard-types.js";

export async function confirmFixes(
  request: FixRequest,
  wizard: WizardIo | undefined,
): Promise<"accepted" | "declined" | "unavailable"> {
  if (request.yes) {
    return "accepted";
  }
  if (wizard !== undefined) {
    const result = await wizard.confirm("Apply this fix plan?");
    return result === "accepted" ? "accepted" : "declined";
  }
  if (!isTerminal(request.stdin) || !isTerminal(request.stdout)) {
    return "unavailable";
  }

  const prompt = createInterface({ input: request.stdin, output: request.stdout });
  try {
    const answer = await prompt.question("\nApply these fixes? [y/N] ");
    return /^y(es)?$/iu.test(answer.trim()) ? "accepted" : "declined";
  } finally {
    prompt.close();
  }
}
