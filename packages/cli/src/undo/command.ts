// Deep import on purpose: see the note in run.ts.
import { Command, Option } from "clipanion/lib/advanced/index.js";

import { createEnvironment } from "@tryaura/core";

import {
  environmentOptions,
  homeOption,
  isTerminal,
  pathOption,
  rejectInvalidPathOptions,
  reportUnexpectedFailure,
  writeOptionRejection,
} from "../command-support.js";
import type { AuraCliContext } from "../commands.js";
import { createInteractiveWizardIo } from "../setup/wizard-prompt.js";
import { createDefaultsWizardIo } from "../setup/wizard-scripted.js";
import type { CliExitCode } from "../types.js";
import { runUndo, type UndoRequest } from "./undo.js";

export class UndoCommand extends Command<AuraCliContext> {
  // fallow-ignore-next-line unused-class-member -- Clipanion reads command metadata at registration.
  static override paths = [["undo"]];
  // fallow-ignore-next-line unused-class-member -- Clipanion reads command metadata at registration.
  static override usage = Command.Usage({
    description: "Restore the files a fix or setup changed.",
    details: `
      Restores the newest restorable backup, or the one named on the command line. Every \`check --fix\` and \`setup\` run that writes saves one first.

      Exit codes: 0 restored or nothing to undo, 1 aborted at the prompt, 2 conflicts or unusable state, 3 operational failures.
    `,
    examples: [
      ["Restore the most recent backup", "$0 undo"],
      ["See every backup", "$0 undo --list"],
      ["Restore one backup by name", "$0 undo 2026-08-16T23-47-43-937Z"],
      ["Restore without being asked", "$0 undo --yes"],
      ["See what would be restored, without writing", "$0 undo --dry-run"],
    ],
  });

  detail = Option.Boolean("--detail", false, {
    description: "Include what failed when the restore fails unexpectedly.",
  });
  dryRun = Option.Boolean("--dry-run", false, {
    description: "Name the backup that would be restored and write nothing.",
  });
  home = homeOption();
  list = Option.Boolean("--list", false, {
    description: "List every backup instead of restoring one.",
  });
  pathValue = pathOption();
  yes = Option.Boolean("--yes", false, {
    description: "Restore without asking. Required when stdin is not a terminal.",
  });
  backupId = Option.String({ required: false });

  // fallow-ignore-next-line unused-class-member -- Clipanion invokes registered command handlers.
  async execute(): Promise<CliExitCode> {
    const rejection = this.rejectInvalidOptions();
    if (rejection !== undefined) {
      return writeOptionRejection(this.context, rejection);
    }

    try {
      return await runUndo(this.buildRequest());
    } catch (error) {
      return reportUnexpectedFailure(
        error,
        "undo",
        this.context.branding,
        this.detail,
        this.context.stderr,
      );
    }
  }

  private buildRequest(): UndoRequest {
    const environment = createEnvironment(
      environmentOptions(this.context, this.home, this.pathValue),
    );
    const io = this.interactive()
      ? createInteractiveWizardIo({
          colorDepth: this.context.colorDepth,
          stdin: this.context.stdin,
          stdout: this.context.stdout,
        })
      : createDefaultsWizardIo(this.context.stdout);

    return {
      backupId: this.backupId,
      branding: this.context.branding,
      dryRun: this.dryRun,
      environment,
      io,
      list: this.list,
      registry: this.context.registry,
      stateHomeDir: this.context.defaultHomeDir,
      stderr: this.context.stderr,
      stdout: this.context.stdout,
      yes: this.yes,
    };
  }

  private interactive(): boolean {
    return !this.yes && isTerminal(this.context.stdin) && isTerminal(this.context.stdout);
  }

  /** The first reason, if any, that this command line cannot mean what the user intended. */
  private rejectInvalidOptions(): string | undefined {
    return (
      this.rejectContradictoryModes() ??
      this.rejectNonInteractiveRestore() ??
      rejectInvalidPathOptions(this.home, this.pathValue)
    );
  }

  private rejectContradictoryModes(): string | undefined {
    if (this.dryRun && this.yes) {
      return "--dry-run and --yes contradict each other: one stops at the preview, the other restores without asking.";
    }
    if (this.list && (this.dryRun || this.yes || this.backupId !== undefined)) {
      return "--list only lists backups. Drop the other arguments to list, or drop --list to restore.";
    }
    return undefined;
  }

  private rejectNonInteractiveRestore(): string | undefined {
    if (this.interactive() || this.yes || this.list || this.dryRun) {
      return undefined;
    }
    return `stdin and stdout must both be terminals before ${this.context.branding.displayName} can ask to restore. Re-run with --yes, or --list to see what could be restored.`;
  }
}
