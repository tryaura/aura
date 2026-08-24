// Deep import on purpose: see the note in run.boundary.ts.
import { Command, Option, type CommandClass } from "clipanion/lib/advanced/index.js";

import type { AuraCliContext } from "./cli-context.js";
import { writeRunFailure } from "./command-support.js";
import type {
  CliCommandDefinition,
  CliCommandFlag,
  CliCommandFlagValue,
  CliExitCode,
} from "./types.js";

/**
 * Adapts one declarative {@link CliCommandDefinition} into the class the command framework
 * registers, keeping clipanion an implementation detail of this package rather than part of the
 * distribution-facing API.
 *
 * The framework discovers options by instantiating the class and scanning its own enumerable
 * properties, so the constructor declares one generated property per flag plus one for the
 * positional rest; parsing later overwrites those same properties with the parsed values.
 */
export function createDistroCommandClass(
  definition: CliCommandDefinition,
): CommandClass<AuraCliContext> {
  const flags = definition.flags ?? [];
  class DistroCommand extends Command<AuraCliContext> {
    static override paths = [[definition.word]];
    static override usage = Command.Usage({ description: definition.summary });

    constructor() {
      super();
      const self = this as unknown as Record<string, unknown>;
      flags.forEach((flag, index) => {
        self[flagKey(index)] = declareFlag(flag);
      });
      self[POSITIONALS_KEY] = Option.Rest();
    }

    async execute(): Promise<CliExitCode> {
      const self = this as unknown as Record<string, unknown>;
      const values: Record<string, CliCommandFlagValue> = {};
      flags.forEach((flag, index) => {
        values[flag.flag] = self[flagKey(index)] as CliCommandFlagValue;
      });
      // Caught here rather than left to the framework, which maps any throw to exit code 1: an
      // escaped error is an operational failure, reported the same one-line way the built-ins use.
      try {
        return await definition.execute({
          branding: this.context.branding,
          colorDepth: this.context.colorDepth,
          cwd: this.context.cwd,
          env: this.context.env,
          flags: Object.freeze(values),
          homeDir: this.context.defaultHomeDir,
          now: this.context.now,
          positionals: self[POSITIONALS_KEY] as readonly string[],
          stderr: this.context.stderr,
          stdin: this.context.stdin,
          stdout: this.context.stdout,
        });
      } catch (error) {
        writeRunFailure(error, this.context.branding, this.context.stderr);
        return 3;
      }
    }
  }
  return DistroCommand;
}

const POSITIONALS_KEY = "positionals";

/** Property key for the flag at `index`, stable between the registration and parsing instances. */
function flagKey(index: number): string {
  return `flag${String(index)}`;
}

function declareFlag(flag: CliCommandFlag): unknown {
  switch (flag.kind) {
    case "array":
      return Option.Array(flag.flag, [], { description: flag.description });
    case "boolean":
      return Option.Boolean(flag.flag, false, { description: flag.description });
    case "string":
      return Option.String(flag.flag, { description: flag.description });
  }
}
