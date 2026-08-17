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
import type { CliExitCode } from "../types.js";
import { safe } from "../safe-text.js";
import { runSetup } from "./setup.js";
import { selectSetupSteps, setupAddKinds } from "./steps/index.js";
import type { SetupStep } from "./types.js";
import { createInteractiveWizardIo } from "./wizard-prompt.js";
import { createDefaultsWizardIo } from "./wizard-scripted.js";

export class SetupCommand extends Command<AuraCliContext> {
  // fallow-ignore-next-line unused-class-member -- Clipanion reads command metadata at registration.
  static override paths = [["setup"]];
  // fallow-ignore-next-line unused-class-member -- Clipanion reads command metadata at registration.
  static override usage = Command.Usage({
    description: "Set up this machine interactively and converge it.",
    examples: [
      ["Run the setup wizard", "$0 setup"],
      ["Accept every proposed default without being asked", "$0 setup --yes"],
      ["See what setup would change, without writing", "$0 setup --dry-run"],
      ["Include the full diff of every change", "$0 setup --detail"],
      ["Open only the snippet picker", "$0 setup --add snippet"],
    ],
  });

  add = Option.String("--add", {
    description: `Run one registered setup addition. Kinds: ${setupAddKinds().join(", ")}.`,
  });
  detail = Option.Boolean("--detail", false, {
    description: "Include the full diff of every planned change. May contain file contents.",
  });
  dryRun = Option.Boolean("--dry-run", false, {
    description: "Stop after the plan summary and write nothing.",
  });
  home = homeOption();
  pathValue = pathOption();
  yes = Option.Boolean("--yes", false, {
    description:
      "Take every proposed default and apply without asking. Required when stdin is not a terminal.",
  });

  // fallow-ignore-next-line unused-class-member -- Clipanion invokes registered command handlers.
  async execute(): Promise<CliExitCode> {
    const options = this.resolveOptions();
    if (options.status === "rejected") {
      return writeOptionRejection(this.context, options.reason);
    }

    const interactive =
      !this.yes && isTerminal(this.context.stdin) && isTerminal(this.context.stdout);
    if (!interactive && !this.yes && !this.dryRun) {
      this.context.stderr.write(
        `${this.context.branding.displayName}: stdin and stdout must both be terminals to run the setup wizard. Re-run with --yes to accept the proposed defaults, or --dry-run to stop at the plan.\n`,
      );
      return 2;
    }

    try {
      const environment = createEnvironment(
        environmentOptions(this.context, this.home, this.pathValue),
      );
      const io = interactive
        ? createInteractiveWizardIo({
            colorDepth: this.context.colorDepth,
            stdin: this.context.stdin,
            stdout: this.context.stdout,
          })
        : createDefaultsWizardIo(this.context.stdout);

      return await runSetup({
        branding: this.context.branding,
        colorDepth: this.context.colorDepth,
        dryRun: this.dryRun,
        environment,
        io,
        registry: this.context.registry,
        stateHomeDir: this.context.defaultHomeDir,
        stderr: this.context.stderr,
        steps: options.steps,
        stdout: this.context.stdout,
        withDetail: this.detail,
      });
    } catch (error) {
      return reportUnexpectedFailure(
        error,
        "setup",
        this.context.branding,
        this.detail,
        this.context.stderr,
      );
    }
  }

  /** The first reason, if any, that this command line cannot mean what the user intended. */
  private resolveOptions():
    | { readonly reason: string; readonly status: "rejected" }
    | { readonly status: "ready"; readonly steps: readonly SetupStep[] } {
    const selected = selectSetupSteps(this.add);
    if (selected.status === "invalid") {
      const valid = selected.validKinds.length === 0 ? "none" : selected.validKinds.join(", ");
      return {
        // `safe`, because the rejected kind is text Aura did not write: an escape sequence in argv
        // reaching the terminal can repaint this line into something that reads like success.
        reason: `unknown --add kind: ${safe(selected.kind)}. Valid kinds: ${valid}.`,
        status: "rejected",
      };
    }
    if (this.dryRun && this.yes) {
      return {
        reason:
          "--dry-run and --yes contradict each other: one stops at the plan, the other applies without asking.",
        status: "rejected",
      };
    }
    const pathRejection = rejectInvalidPathOptions(this.home, this.pathValue);
    return pathRejection === undefined ? selected : { reason: pathRejection, status: "rejected" };
  }
}
