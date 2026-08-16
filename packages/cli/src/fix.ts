import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

import {
  applyFixPlan,
  prepareAutomaticFixes,
  type CheckDiagnostic,
  type PreparedFixPlan,
} from "@tryaura/core";
import type { Check, Environment, Finding, WorkspaceModel } from "@tryaura/aura-sdk";

import { isTerminal } from "./command-support.js";
import { renderManualSteps, renderOperationPreviews } from "./preview-render.js";
import { safe } from "./render.js";
import type { CliBranding, CliExitCode } from "./types.js";

/** Everything one `--fix` pass needs, so the flow does not reach back into the command object. */
export interface FixRequest {
  readonly branding: CliBranding;
  readonly checks: readonly Check[];
  readonly dryRun: boolean;
  readonly environment: Environment;
  readonly findings: readonly Finding[];
  readonly model: WorkspaceModel;
  readonly stderr: Writable;
  readonly stdin: Readable;
  /** Home captured before `--home`, used for locks shared by every run from this process boundary. */
  readonly stateHomeDir: string;
  readonly stdout: Writable;
  /** Whether the preview may quote the contents of the files it rewrites. */
  readonly withDetail: boolean;
  readonly yes: boolean;
}

/** What one `--fix` pass did, and whether the run can carry on to the report. */
export interface FixOutcome {
  /** Whether the filesystem changed, which is what makes a second scan worth its cost. */
  readonly applied: boolean;
  readonly diagnostics: readonly CheckDiagnostic[];
  /** Set only when the run must stop here. */
  readonly exitCode?: CliExitCode | undefined;
}

/**
 * Previews the available fixes and, once the user agrees, applies them.
 *
 * `exitCode` is set only when the run must stop before the report: a blocked plan, or a request to
 * write that Aura could not put to the user. Declining at the prompt is not an error — the report
 * still runs, and its findings decide the code.
 */
export async function runFixes(request: FixRequest): Promise<FixOutcome> {
  const { diagnostics, manualSteps, prepared } = await prepareAutomaticFixes({
    checks: request.checks,
    findings: request.findings,
    model: request.model,
  });

  if (prepared === undefined) {
    request.stdout.write(
      request.findings.length === 0
        ? "Nothing to fix.\n\n"
        : "No fixes are available for the findings below.\n\n",
    );
    renderManualSteps(manualSteps, request.stdout);
    return { applied: false, diagnostics };
  }

  renderFixPreview(prepared, manualSteps, request.withDetail, request.stdout);

  if (prepared.preview.conflictedOperationCount > 0) {
    request.stderr.write(
      `${request.branding.displayName}: fixes are blocked by the current state of these files; nothing was changed.\n`,
    );
    return { applied: false, diagnostics, exitCode: 2 };
  }

  if (request.dryRun) {
    request.stdout.write("\nDry run: nothing was written.\n\n");
    return { applied: false, diagnostics };
  }

  const confirmation = await confirmFixes(request);
  if (confirmation === "unavailable") {
    request.stderr.write(
      `${request.branding.displayName}: stdin is not a terminal, so Aura cannot ask before writing to your home directory. Re-run with --yes to apply these fixes, or --dry-run to stop at the preview.\n`,
    );
    return { applied: false, diagnostics, exitCode: 2 };
  }
  if (confirmation === "declined") {
    request.stdout.write("\nLeft everything as it was.\n\n");
    return { applied: false, diagnostics };
  }

  const result = await applyFixPlan(prepared, {
    now: request.environment.now,
    stateHomeDir: request.stateHomeDir,
  });
  request.stdout.write(`\nApplied ${String(result.appliedOperationCount)} fix operation(s).\n`);
  if (result.backupId !== undefined) {
    request.stdout.write(`The previous contents are saved as backup ${safe(result.backupId)}.\n`);
  }
  request.stdout.write("\n");
  return { applied: true, diagnostics };
}

/**
 * Asks before writing, because a fix rewrites files under the user's home directory.
 *
 * `--yes` is the scripted answer. Without a terminal there is no way to ask, and silently taking
 * consent that was never given is the one outcome worth failing over.
 */
async function confirmFixes(request: FixRequest): Promise<"accepted" | "declined" | "unavailable"> {
  if (request.yes) {
    return "accepted";
  }
  if (!isTerminal(request.stdin)) {
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

/** Shows what applying the plan would do; only the shape of each change unless `withDetail`. */
function renderFixPreview(
  prepared: PreparedFixPlan,
  manualSteps: readonly string[],
  withDetail: boolean,
  output: Writable,
): void {
  output.write(`Fix preview: ${safe(prepared.preview.summary)}\n`);
  renderOperationPreviews(prepared.preview.operations, withDetail, output);

  if (!withDetail) {
    output.write("\nRe-run with --detail to see the full diff of every change.\n");
  }
  renderManualSteps(manualSteps, output);
}
