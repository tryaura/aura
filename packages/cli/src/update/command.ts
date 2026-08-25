// Deep import on purpose: see the note in run.boundary.ts.
import { Command } from "clipanion/lib/advanced/index.js";

import type { AuraCliContext } from "../cli-context.js";
import type { CliExitCode } from "../types.js";

/** The explicit update is performed by the standalone runner before command dispatch. */
export class UpdateCommand extends Command<AuraCliContext> {
  // fallow-ignore-next-line unused-class-member -- Clipanion reads command metadata at registration.
  static override paths = [["update"]];
  // fallow-ignore-next-line unused-class-member -- Clipanion reads command metadata at registration.
  static override usage = Command.Usage({
    description: "Check for and install an Aura update, bypassing the update cache.",
  });

  // fallow-ignore-next-line unused-class-member -- exact update runs exit before dispatch.
  execute(): Promise<CliExitCode> {
    return Promise.resolve(0);
  }
}
