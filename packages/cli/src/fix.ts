import type { Readable, Writable } from "node:stream";

import {
  applyFixPlan,
  collectAutomaticFixCandidates,
  describeFailure,
  FixPlanApplyError,
  prepareFixCandidates,
  type CheckDiagnostic,
} from "@tryaura/core";
import type { Check, Environment, Finding, WorkspaceModel } from "@tryaura/aura-sdk";

import { confirmFixes } from "./fix-confirmation.js";
import { reportFixes, reportUnpreparedFixes } from "./fix-report.js";
import { gatherGuidedFixes, orderCandidates } from "./guided-fix.js";
import { renderFixPreview, renderGuidedHint, renderManualSteps } from "./preview-render.js";
import type { DiagnosticSource, ReportFix } from "./report.js";
import { safe } from "./render.js";
import { createInteractiveWizardIo } from "./setup/wizard-prompt.js";
import type { WizardIo } from "./setup/wizard-types.js";
import type { CliBranding, CliExitCode } from "./types.js";

export interface FixRequest {
  /**
   * Test seam for the one call that writes; production uses the kernel's own {@link applyFixPlan}.
   *
   * A rollback that itself fails cannot be staged through the filesystem — it needs a write to fail
   * after an earlier write succeeded, and then the undo of that earlier write to fail too — so the
   * branch that reports a half-applied plan is reachable in a test only from here.
   */
  readonly applyPlan?: typeof applyFixPlan | undefined;
  readonly branding: CliBranding;
  readonly checks: readonly Check[];
  readonly colorDepth: number;
  readonly dryRun: boolean;
  readonly environment: Environment;
  readonly findings: readonly Finding[];
  readonly interactive: boolean;
  readonly model: WorkspaceModel;
  readonly stderr: Writable;
  readonly stdin: Readable;
  readonly stateHomeDir: string;
  readonly stdout: Writable;
  readonly withDetail: boolean;
  /** Test seam for scripted guided choices; production uses the terminal implementation. */
  readonly wizard?: WizardIo | undefined;
  readonly yes: boolean;
}

export interface FixOutcome {
  readonly applied: boolean;
  readonly diagnostics: readonly CheckDiagnostic[];
  readonly exitCode?: CliExitCode | undefined;
  readonly fixDiagnostics: readonly DiagnosticSource[];
  readonly fixes: readonly ReportFix[];
}

// fallow-ignore-next-line complexity -- coordinates one transaction across explicit terminal states.
export async function runFixes(request: FixRequest): Promise<FixOutcome> {
  const automatic = collectAutomaticFixCandidates({
    checks: request.checks,
    findings: request.findings,
    model: request.model,
  });
  const fixDiagnostics: DiagnosticSource[] = [];
  let candidates = [...automatic.candidates];
  let wizard = request.wizard;

  if (request.interactive) {
    wizard ??= createInteractiveWizardIo({
      colorDepth: request.colorDepth,
      stdin: request.stdin,
      stdout: request.stdout,
    });
    const guided = await gatherGuidedFixes(request, wizard, fixDiagnostics);
    if (guided === "aborted") {
      request.stdout.write("\nLeft everything as it was.\n\n");
      let prepared: Awaited<ReturnType<typeof prepareFixCandidates>>;
      try {
        prepared = await prepareFixCandidates({ candidates, model: request.model });
      } catch (error) {
        fixDiagnostics.push({
          detail: describeFailure(error),
          id: "core/fix-plan",
          message: "The automatic fix plan could not be prepared. Nothing was changed.",
          phase: "fix",
        });
        return {
          applied: false,
          diagnostics: automatic.diagnostics,
          exitCode: 3,
          fixDiagnostics,
          fixes: reportUnpreparedFixes(candidates),
        };
      }
      return {
        applied: false,
        diagnostics: automatic.diagnostics,
        fixDiagnostics,
        fixes: reportFixes(
          prepared,
          "planned",
          request.withDetail,
          "Aborted before confirmation. Nothing was changed.",
        ),
      };
    }
    candidates = orderCandidates([...candidates, ...guided], request.findings);
  }

  let prepared: Awaited<ReturnType<typeof prepareFixCandidates>>;
  try {
    prepared = await prepareFixCandidates({ candidates, model: request.model });
  } catch (error) {
    fixDiagnostics.push({
      detail: describeFailure(error),
      id: "core/fix-plan",
      message: "The combined fix plan could not be prepared. Nothing was changed.",
      phase: "fix",
    });
    return {
      applied: false,
      diagnostics: automatic.diagnostics,
      exitCode: 3,
      fixDiagnostics,
      fixes: reportUnpreparedFixes(candidates),
    };
  }
  if (prepared.prepared === undefined) {
    request.stdout.write(
      request.findings.length === 0
        ? "Nothing to fix.\n\n"
        : "No executable fixes are available for the findings below.\n\n",
    );
    renderManualSteps(prepared.manualSteps, request.stdout);
    if (!request.interactive) {
      renderGuidedHint(request.checks, request.findings, request.branding, request.stdout);
    }
    return {
      applied: false,
      diagnostics: automatic.diagnostics,
      fixDiagnostics,
      fixes: [],
    };
  }

  renderFixPreview(prepared, request.withDetail, request.stdout);

  if (prepared.prepared.preview.conflictedOperationCount > 0) {
    request.stderr.write(
      `${request.branding.displayName}: fixes are blocked by the current state of these files; nothing was changed.\n`,
    );
    return {
      applied: false,
      diagnostics: automatic.diagnostics,
      exitCode: 2,
      fixDiagnostics,
      fixes: reportFixes(prepared, "failed", request.withDetail, "The plan is conflicted."),
    };
  }

  if (request.dryRun) {
    request.stdout.write("\nDry run: nothing was written.\n\n");
    return {
      applied: false,
      diagnostics: automatic.diagnostics,
      fixDiagnostics,
      fixes: reportFixes(prepared, "planned", request.withDetail),
    };
  }

  const confirmation = await confirmFixes(request, wizard);
  if (confirmation === "unavailable") {
    request.stderr.write(
      `${request.branding.displayName}: stdin and the prompt output must both be terminals before Aura can ask to write. Re-run with --yes, or --dry-run to stop at the preview.\n`,
    );
    return {
      applied: false,
      diagnostics: automatic.diagnostics,
      exitCode: 2,
      fixDiagnostics,
      fixes: reportFixes(
        prepared,
        "planned",
        request.withDetail,
        "Not applied: the confirmation prompt is unavailable in this terminal. Re-run with --yes, or --dry-run to stop at the preview.",
      ),
    };
  }
  if (confirmation === "declined") {
    request.stdout.write("\nLeft everything as it was.\n\n");
    return {
      applied: false,
      diagnostics: automatic.diagnostics,
      fixDiagnostics,
      fixes: reportFixes(prepared, "planned", request.withDetail),
    };
  }

  try {
    const result = await (request.applyPlan ?? applyFixPlan)(prepared.prepared, {
      now: request.environment.now,
      stateHomeDir: request.stateHomeDir,
    });
    request.stdout.write(`\nApplied ${String(result.appliedOperationCount)} fix operation(s).\n`);
    if (result.backupId !== undefined) {
      request.stdout.write(
        `The previous contents are saved as backup ${safe(result.backupId)}. Run ${request.branding.command} undo to restore them.\n`,
      );
    }
    request.stdout.write("\n");
    return {
      applied: true,
      diagnostics: automatic.diagnostics,
      fixDiagnostics,
      fixes: reportFixes(prepared, "applied", request.withDetail),
    };
  } catch (error) {
    if (
      error instanceof FixPlanApplyError &&
      error.code === "filesystem-changed" &&
      error.rollback !== "failed"
    ) {
      request.stderr.write(
        `${request.branding.displayName}: a file changed after the preview; the fix was not applied.\n`,
      );
      return {
        applied: false,
        diagnostics: automatic.diagnostics,
        exitCode: 2,
        fixDiagnostics,
        fixes: reportFixes(
          prepared,
          "failed",
          request.withDetail,
          "A file changed after the preview.",
        ),
      };
    }
    // Rollback can itself fail, and then operations are still on disk. Saying "rolled back" here
    // would be the one wrong thing to tell someone whose home directory is half-rewritten, so the
    // two outcomes are reported as two outcomes.
    if (error instanceof FixPlanApplyError && error.rollback === "failed") {
      const stranded = String(error.appliedOperationCount);
      request.stderr.write(
        `${request.branding.displayName}: the fix failed and ${stranded} operation(s) could not be undone. Your files are partly changed; review them before re-running.\n`,
      );
      fixDiagnostics.push({
        detail: describeFailure(error),
        id: "core/fix-plan",
        message: `The fix plan failed and ${stranded} completed operation(s) could not be rolled back. The filesystem is partly changed.`,
        phase: "fix",
      });
      // Applied, so the report re-scans: after a partial write the only useful report is one that
      // describes the machine as it is now, not as it was before the attempt.
      return {
        applied: true,
        diagnostics: automatic.diagnostics,
        exitCode: 3,
        fixDiagnostics,
        fixes: reportFixes(
          prepared,
          "partial",
          request.withDetail,
          "Apply failed and rollback did not complete.",
        ),
      };
    }

    fixDiagnostics.push({
      detail: describeFailure(error),
      id: "core/fix-plan",
      message: "The fix plan failed and its completed operations were rolled back.",
      phase: "fix",
    });
    return {
      applied: false,
      diagnostics: automatic.diagnostics,
      exitCode: 3,
      fixDiagnostics,
      fixes: reportFixes(prepared, "failed", request.withDetail, "Apply failed and rolled back."),
    };
  }
}
