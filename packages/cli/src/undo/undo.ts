import type { Writable } from "node:stream";

import type { Environment, UndoRunOutcome } from "@tryaura/aura-sdk";
import {
  buildWorkspaceModel,
  FixPlanError,
  FixPlanUndoError,
  listFixPlanBackups,
  undoFixPlan,
  type FixPlanBackup,
  type PluginRegistry,
} from "@tryaura/core";
import { pluralize } from "@tryaura/core/pluralize";

import { safe } from "../safe-text.js";
import type { WizardIo } from "../setup/wizard-types.js";
import { undoRunEvent, type UndoRunFacts } from "../telemetry-events.js";
import type { TelemetryRecorder } from "../telemetry.js";
import type { CliBranding, CliExitCode } from "../types.js";

/** Everything one `undo` run needs, so the flow does not reach back into the command object. */
export interface UndoRequest {
  /** Restores this entry instead of the newest undoable one. */
  readonly backupId?: string | undefined;
  readonly branding: CliBranding;
  readonly dryRun: boolean;
  readonly environment: Environment;
  readonly io: WizardIo;
  readonly list: boolean;
  readonly registry: PluginRegistry;
  /** Home captured before `--home`, used for locks shared by every run from this process boundary. */
  readonly stateHomeDir: string;
  readonly stderr: Writable;
  readonly stdout: Writable;
  /** The run's telemetry recorder. A no-op unless the distribution composed a sink. */
  readonly telemetry: TelemetryRecorder;
  readonly yes: boolean;
}

/** The one telemetry funnel: every return passes through it, so a run emits exactly once. */
function emit(
  request: UndoRequest,
  exitCode: CliExitCode,
  outcome: UndoRunOutcome,
  extras?: Omit<UndoRunFacts, "exitCode" | "outcome">,
): CliExitCode {
  request.telemetry.record(undoRunEvent({ exitCode, outcome, ...extras }));
  return exitCode;
}

type ReadableBackup = Exclude<FixPlanBackup, { status: "unreadable" }>;

/**
 * The `undo` flow: read the journal, pick an entry, confirm once, restore.
 *
 * The entry is pinned by id before the prompt, so what the user confirmed is exactly what gets
 * restored even if another run stages a newer backup in between. The workspace model — the policy
 * deciding which roots a restore may write to, the same one the fix that made the backup ran
 * under — is built only once a restore will actually write; listing, dry runs, and refusals stay
 * pure journal reads.
 */
export async function runUndo(request: UndoRequest): Promise<CliExitCode> {
  const { branding, stdout } = request;

  try {
    const backups = await listFixPlanBackups({ homeDir: request.environment.homeDir });
    if (request.list) {
      renderBackupList(backups, branding, stdout);
      return emit(request, 0, "listed");
    }

    if (request.backupId !== undefined) {
      const named = backups.find((backup) => backup.id === request.backupId);
      if (named === undefined) {
        request.stderr.write(
          `${branding.displayName}: no backup named ${safe(request.backupId)} exists. Run ${branding.command} undo --list to see every backup.\n`,
        );
        return emit(request, 2, "refused");
      }
      if (!isReadable(named)) {
        request.stderr.write(
          `${branding.displayName}: backup ${safe(named.id)} cannot be read — ${safe(named.reason)}.\n`,
        );
        return emit(request, 2, "refused");
      }
      if (!named.undoable) {
        request.stderr.write(
          `${branding.displayName}: backup ${safe(named.id)} is already ${named.status} and cannot be undone.\n`,
        );
        return emit(request, 2, "refused");
      }
      return await restoreBackup(request, named);
    }

    const readable = backups.filter(isReadable);
    const unreadable = backups.length - readable.length;
    const latest = readable.find((backup) => backup.undoable);
    if (latest === undefined) {
      if (unreadable > 0) {
        request.stderr.write(
          `${branding.displayName}: ${String(unreadable)} ${pluralize(unreadable, "backup")} could not be read and nothing restorable remains. Run ${branding.command} undo --list for details.\n`,
        );
        return emit(request, 2, "refused");
      }
      stdout.write("Nothing to undo.\n");
      return emit(request, 0, "nothing-to-undo");
    }
    return await restoreBackup(request, latest);
  } catch (error) {
    return reportUndoFailure(error, request);
  }
}

async function restoreBackup(request: UndoRequest, backup: ReadableBackup): Promise<CliExitCode> {
  const { stdout } = request;
  const described = `backup ${safe(backup.id)} (${String(backup.operationCount)} ${pluralize(backup.operationCount, "operation")})`;

  if (request.dryRun) {
    stdout.write(
      `Would restore ${described} from ${safe(backup.createdAt)}. Nothing was written.\n`,
    );
    return emit(request, 0, "dry-run");
  }

  if (!request.yes) {
    const confirmation = await request.io.confirm(
      `Restore ${described}? This rewrites the files it changed.`,
    );
    if (confirmation !== "accepted") {
      // Declining and aborting both end the run without restoring anything, and the documented
      // contract folds them into one word: exit 1, aborted or declined at the prompt.
      stdout.write("\nLeft everything as it was.\n");
      return emit(request, 1, "declined");
    }
  }

  const scan = await buildWorkspaceModel({
    adapters: request.registry.adapters,
    environment: request.environment,
    mcpCatalog: request.registry.mcpServers,
    skills: request.registry.skills,
  });
  const result = await undoFixPlan({
    backupId: backup.id,
    model: scan.model,
    now: request.environment.now,
    stateHomeDir: request.stateHomeDir,
  });
  if (result.status === "nothing-to-undo") {
    stdout.write("Nothing to undo.\n");
    return emit(request, 0, "nothing-to-undo");
  }

  stdout.write(
    `Restored backup ${safe(result.backupId)} (${String(result.restoredOperationCount)} ${pluralize(result.restoredOperationCount, "operation")}).\n`,
  );
  if (result.skippedBackupIds.length > 0) {
    stdout.write(
      `Skipped ${String(result.skippedBackupIds.length)} unreadable newer ${pluralize(result.skippedBackupIds.length, "backup")}: ${result.skippedBackupIds.map(safe).join(", ")}.\n`,
    );
  }
  return emit(request, 0, "restored", {
    restoredOperationCount: result.restoredOperationCount,
    skippedBackupCount: result.skippedBackupIds.length,
  });
}

function renderBackupList(
  backups: readonly FixPlanBackup[],
  branding: CliBranding,
  output: Writable,
): void {
  if (backups.length === 0) {
    output.write(
      `No backups. Nothing has been changed by ${branding.command} check --fix or ${branding.command} setup yet.\n`,
    );
    return;
  }

  output.write(`${branding.displayName} backups\n\n`);
  for (const backup of backups) {
    if (backup.status === "unreadable") {
      output.write(`  ${safe(backup.id)}  unreadable — ${safe(backup.reason)}\n`);
      continue;
    }
    output.write(
      `  ${safe(backup.id)}  ${safe(backup.createdAt)}  ${String(backup.operationCount)} ${pluralize(backup.operationCount, "operation")}  ${backup.status}\n`,
    );
  }
  if (backups.some((backup) => backup.undoable)) {
    output.write(`\nRun ${branding.command} undo [<id>] to restore one.\n`);
  }
}

function isReadable(backup: FixPlanBackup): backup is ReadableBackup {
  return backup.status !== "unreadable";
}

/**
 * Maps a failed restore onto the exit-code contract.
 *
 * A restore that rolled back (or never wrote) left the filesystem as the user knows it: that is a
 * state conflict, exit 2, and the journal's own message says which file moved underneath it. A
 * failed rollback is the one case where the machine is in a state nobody asked for, so it is an
 * operational failure and says so before anything else.
 */
function reportUndoFailure(error: unknown, request: UndoRequest): CliExitCode {
  const { branding } = request;
  if (error instanceof FixPlanUndoError && error.rollback === "failed") {
    request.stderr.write(
      `${branding.displayName}: the restore failed and could not be fully rolled back. Review the files it touched before re-running. (${safe(error.message)})\n`,
    );
    return emit(request, 3, "failed");
  }
  if (error instanceof FixPlanError) {
    request.stderr.write(`${branding.displayName}: ${safe(error.message)}\n`);
    return emit(request, 2, "failed");
  }
  throw error;
}
