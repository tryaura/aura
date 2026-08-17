// Deep import on purpose: see the note in run.ts.
import { Command } from "clipanion/lib/advanced/index.js";

import type { AuraCliContext } from "./commands.js";
import { renderRootHelp } from "./help.js";
import type { CliExitCode } from "./types.js";

export class DefaultCommand extends Command<AuraCliContext> {
  // fallow-ignore-next-line unused-class-member -- Clipanion reads command metadata at registration.
  static override paths = [Command.Default];
  // fallow-ignore-next-line unused-class-member -- Clipanion reads command metadata at registration.
  static override usage = Command.Usage({ description: "Show command help." });

  // fallow-ignore-next-line unused-class-member -- Clipanion invokes registered command handlers.
  async execute(): Promise<CliExitCode> {
    this.context.stdout.write(renderRootHelp(this.context.branding));
    return 0;
  }
}
