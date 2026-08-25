// Deep import on purpose: see the note in run.boundary.ts.
import { UnknownSyntaxError } from "clipanion/lib/errors.js";

import { CheckCommand } from "./commands.js";
import { renderCheckHelp, renderRootHelp, renderSetupHelp, renderUndoHelp } from "./help.js";
import { renderDistroCommandHelp } from "./help-distro-command.js";
import { SetupCommand } from "./setup/command.js";
import { setupAddKinds } from "./setup/steps/index.js";
import { UndoCommand } from "./undo/command.js";
import { renderUpdateHelp } from "./update/help.js";
import type { CliBranding, CliCommandDefinition } from "./types.js";

/** First tokens of the statically registered command paths, kept next to their registrations. */
const STATIC_COMMAND_WORDS: ReadonlySet<string> = new Set(
  [
    ...(CheckCommand.paths ?? []),
    ...(SetupCommand.paths ?? []),
    ...(UndoCommand.paths ?? []),
  ].flatMap((path) => (path[0] === undefined ? [] : [path[0]])),
);

/**
 * Every command word this run answers to: the built-ins plus the distribution's own.
 *
 * `update` registers only where the entry point owns an executable it may update, so it counts as
 * known exactly when it parses.
 */
export function knownCommandWords(
  canUpdate: boolean,
  commands: readonly CliCommandDefinition[],
): ReadonlySet<string> {
  return new Set([
    ...STATIC_COMMAND_WORDS,
    ...(canUpdate ? ["update"] : []),
    ...commands.map((command) => command.word),
  ]);
}

/**
 * The misspelled command behind a parse error, or undefined when the input's problem is elsewhere.
 *
 * A bad flag on a real command raises the same error class, and there clipanion's message — which
 * names the offending flag — is the more useful one, so only a genuinely unknown first word gets
 * the redirect screen.
 */
export function unknownCommandInput(
  error: unknown,
  argv: readonly string[],
  known: ReadonlySet<string>,
): string | undefined {
  const first = argv[0];
  if (!(error instanceof UnknownSyntaxError) || first === undefined || first.startsWith("-")) {
    return undefined;
  }
  return known.has(first) ? undefined : first;
}

/** The help screen `-h` anywhere in the input was asking for, decided by the command word. */
export function helpScreen(
  argv: readonly string[],
  branding: CliBranding,
  canUpdate: boolean,
  commands: readonly CliCommandDefinition[],
): string {
  const word = argv.find((token) => !token.startsWith("-"));
  if (word === "check") {
    return renderCheckHelp(branding);
  }
  if (word === "setup") {
    return renderSetupHelp(branding, setupAddKinds());
  }
  if (word === "undo") {
    return renderUndoHelp(branding);
  }
  if (word === "update" && canUpdate) {
    return renderUpdateHelp(branding);
  }
  const definition = commands.find((command) => command.word === word);
  if (definition !== undefined) {
    return renderDistroCommandHelp(branding, definition);
  }
  return renderRootHelp(branding, canUpdate, commands);
}
