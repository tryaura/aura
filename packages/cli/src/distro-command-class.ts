// Deep import on purpose: see the note in run.boundary.ts.
import { Command, Option, type CommandClass } from "clipanion/lib/advanced/index.js";

import { createEnvironment } from "@tryaura/core";

import type { AuraCliContext } from "./cli-context.js";
import { environmentOptions, writeRunFailure } from "./command-support.js";
import type {
  CliCommandDefinition,
  CliCommandFlag,
  CliCommandFlagValue,
  CliCommandTelemetry,
  CliExitCode,
} from "./types.js";

/** Exit code and telemetry event a command that threw past its own error handling reports. */
const FAILURE_EXIT_CODE = 3;
const FAILURE_EVENT = "command-failed";

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
      const telemetry = scopedTelemetry(this.context, definition.word);
      // Caught here rather than left to the framework, which maps any throw to exit code 1: an
      // escaped error is an operational failure, reported the same one-line way the built-ins use
      // and recorded the same way, so a distribution sees its own crashes without instrumenting
      // every command by hand.
      try {
        return await definition.execute({
          branding: this.context.branding,
          colorDepth: this.context.colorDepth,
          // Built from the boundary values alone. `--home` and `--path` belong to the built-in
          // commands, so they stay off a help screen that would not honour them; a distribution
          // command that needs a different root declares its own flag and applies it to the paths
          // it builds.
          environment: createEnvironment(environmentOptions(this.context, undefined, undefined)),
          flags: Object.freeze(values),
          positionals: self[POSITIONALS_KEY] as readonly string[],
          stderr: this.context.stderr,
          stdin: this.context.stdin,
          stdout: this.context.stdout,
          telemetry,
        });
      } catch (error) {
        // Recorded on the run's recorder directly: the scoped channel refuses the reserved event,
        // so only a genuine crash can produce this record.
        this.context.telemetry.record({
          command: definition.word,
          event: FAILURE_EVENT,
          exitCode: FAILURE_EXIT_CODE,
          kind: "distro-command",
        });
        writeRunFailure(error, this.context.branding, this.context.stderr);
        return FAILURE_EXIT_CODE;
      }
    }
  }
  return DistroCommand;
}

const POSITIONALS_KEY = "positionals";

/**
 * The run's recorder, narrowed to one command word.
 *
 * The word and event kind are stamped here rather than accepted from the definition, so a command
 * cannot attribute an event to a built-in or to another distribution command. `command-failed` is
 * reserved for the CLI's own crash record, so an event a command records under that label is
 * dropped rather than passed off as a real crash.
 */
function scopedTelemetry(context: AuraCliContext, word: string): CliCommandTelemetry {
  return {
    record: (event) => {
      if (event.event === FAILURE_EVENT) {
        return;
      }
      context.telemetry.record({ ...event, command: word, kind: "distro-command" });
    },
  };
}

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
