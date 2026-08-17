import type { Writable } from "node:stream";

import type { Environment, WorkspaceModel } from "@tryaura/aura-sdk";
import {
  buildWorkspaceModel,
  FixPlanError,
  FixPlanUndoError,
  listFixPlanBackups,
  undoFixPlan,
  type FixPlanBackup,
  type PluginRegistry,
} from "@tryaura/core";

import { safe } from "../render.js";
import type { WizardIo } from "../setup/wizard-types.js";
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
  readonly yes: boolean;
}

type ReadableBackup = Exclude<FixPlanBackup, { status: "unreadable" }>;

/**
 * The `undo` flow: scan, pick a journal entry, confirm once, restore.
 *
 * The workspace is scanned first because the model decides which roots a restore may write to —
 * the same policy the fix that made the backup ran under. The entry is pinned by id before the
 * prompt, so what the user confirmed is exactly what gets restored even if another run stages a
 * newer backup in between.
 */
export async function runUndo(request: UndoRequest): Promise<CliExitCode> {
  const { branding, stdout } = request;

  const scan = await buildWorkspaceModel({
    adapters: request.registry.adapters,
    environment: request.environment,
    snippets: request.registry.snippets,
  });

  try {
    const backups = await listFixPlanBackups({ model: scan.model });
    if (request.list) {
      renderBackupList(backups, branding, stdout);
      return 0;
    }

    const readable = backups.filter(isReadable);
    const unreadable = backups.length - readable.length;

    if (request.backupId !== undefined) {
      const named = readable.find((backup) => backup.id === request.backupId);
      if (named === undefined) {
        request.stderr.write(
          `${branding.displayName}: no backup named ${safe(request.backupId)} can be restored. Run ${branding.command} undo --list to see every backup.\n`,
        );
        return 2;
      }
      if (!named.undoable) {
        request.stderr.write(
          `${branding.displayName}: backup ${safe(named.id)} is already ${named.status} and cannot be undone.\n`,
        );
        return 2;
      }
      return await restoreBackup(request, scan.model, named);
    }

    const latest = readable.find((backup) => backup.undoable);
    if (latest === undefined) {
      if (unreadable > 0) {
        request.stderr.write(
          `${branding.displayName}: ${String(unreadable)} backup(s) could not be read and nothing restorable remains. Run ${branding.command} undo --list for details.\n`,
        );
        return 2;
      }
      stdout.write("Nothing to undo.\n");
      return 0;
    }
    return await restoreBackup(request, scan.model, latest);
  } catch (error) {
    return reportUndoFailure(error, request);
  }
}

async function restoreBackup(
  request: UndoRequest,
  model: WorkspaceModel,
  backup: ReadableBackup,
): Promise<CliExitCode> {
  const { stdout } = request;
  const described = `backup ${safe(backup.id)} (${String(backup.operationCount)} operation(s))`;

  if (request.dryRun) {
    stdout.write(
      `Would restore ${described} from ${safe(backup.createdAt)}. Nothing was written.\n`,
    );
    return 0;
  }

  if (!request.yes) {
    const confirmation = await request.io.confirm(
      `Restore ${described}? This rewrites the files it changed.`,
    );
    if (confirmation !== "accepted") {
      stdout.write("\nLeft everything as it was.\n");
      return confirmation === "aborted" ? 1 : 0;
    }
  }

  const result = await undoFixPlan({
    backupId: backup.id,
    model,
    now: request.environment.now,
    stateHomeDir: request.stateHomeDir,
  });
  if (result.status === "nothing-to-undo") {
    stdout.write("Nothing to undo.\n");
    return 0;
  }

  stdout.write(
    `Restored backup ${safe(result.backupId)} (${String(result.restoredOperationCount)} operation(s)).\n`,
  );
  if (result.skippedBackupIds.length > 0) {
    stdout.write(
      `Skipped ${String(result.skippedBackupIds.length)} unreadable newer backup(s): ${result.skippedBackupIds.map(safe).join(", ")}.\n`,
    );
  }
  return 0;
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
      `  ${safe(backup.id)}  ${safe(backup.createdAt)}  ${String(backup.operationCount)} operation(s)  ${backup.status}\n`,
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
    return 3;
  }
  if (error instanceof FixPlanError) {
    request.stderr.write(`${branding.displayName}: ${safe(error.message)}\n`);
    return 2;
  }
  throw error;
}
