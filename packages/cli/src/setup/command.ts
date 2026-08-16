// Deep import on purpose: see the note in run.ts.
import { Command, Option } from "clipanion/lib/advanced/index.js";

import { createEnvironment } from "@tryaura/core";

import {
  environmentOptions,
  isTerminal,
  rejectInvalidPathOptions,
  reportUnexpectedFailure,
} from "../command-support.js";
import type { AuraCliContext } from "../commands.js";
import type { CliExitCode } from "../types.js";
import { runSetup } from "./setup.js";
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
    ],
  });

  detail = Option.Boolean("--detail", false, {
    description: "Include the full diff of every planned change. May contain file contents.",
  });
  dryRun = Option.Boolean("--dry-run", false, {
    description: "Stop after the plan summary and write nothing.",
  });
  home = Option.String("--home", { description: "Override the home directory." });
  pathValue = Option.String("--path", { description: "Override the executable search path." });
  yes = Option.Boolean("--yes", false, {
    description:
      "Take every proposed default and apply without asking. Required when stdin is not a terminal.",
  });

  // fallow-ignore-next-line unused-class-member -- Clipanion invokes registered command handlers.
  async execute(): Promise<CliExitCode> {
    const rejection = this.rejectInvalidOptions();
    if (rejection !== undefined) {
      this.context.stderr.write(`${this.context.branding.displayName}: ${rejection}\n`);
      return 2;
    }

    const interactive = !this.yes && isTerminal(this.context.stdin);
    if (!interactive && !this.yes && !this.dryRun) {
      this.context.stderr.write(
        `${this.context.branding.displayName}: stdin is not a terminal, so Aura cannot run the setup wizard. Re-run with --yes to accept the proposed defaults, or --dry-run to stop at the plan.\n`,
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
        dryRun: this.dryRun,
        environment,
        io,
        registry: this.context.registry,
        stderr: this.context.stderr,
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
  private rejectInvalidOptions(): string | undefined {
    if (this.dryRun && this.yes) {
      return "--dry-run and --yes contradict each other: one stops at the plan, the other applies without asking.";
    }
    return rejectInvalidPathOptions(this.home, this.pathValue);
  }
}
