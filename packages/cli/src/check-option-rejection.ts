import type { Readable, Writable } from "node:stream";

import { isTerminal, rejectInvalidPathOptions } from "./command-support.js";
import { explainOptionRejection, fixOptionRejection } from "./check-options.js";
import { safe } from "./safe-text.js";

/** Every flag the `check` command validates before it touches the machine. */
export interface CheckOptionValues {
  readonly detail: boolean;
  readonly dryRun: boolean;
  readonly explaining: boolean;
  readonly fix: boolean;
  readonly home: string | undefined;
  readonly interactive: boolean;
  readonly json: boolean;
  readonly jsonVersion: string | undefined;
  readonly online: boolean;
  readonly only: readonly string[];
  readonly pathValue: string | undefined;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly yes: boolean;
}

/**
 * Returns why this combination of flags cannot be run, in the order a user meets them.
 *
 * Kept off the command class so the rules can be exercised as data rather than by constructing a
 * Clipanion command, and so adding a flag means adding a field rather than another method.
 */
export function rejectInvalidCheckOptions(options: CheckOptionValues): string | undefined {
  return (
    rejectInvalidJsonOptions(options) ??
    rejectInvalidFixOptions(options) ??
    rejectInvalidExplainOptions(options) ??
    rejectInvalidPathOptions(options.home, options.pathValue)
  );
}

function rejectInvalidExplainOptions(options: CheckOptionValues): string | undefined {
  return explainOptionRejection({
    detail: options.detail,
    explaining: options.explaining,
    fix: options.fix,
    interactive: options.interactive,
    online: options.online,
    only: options.only.length > 0,
  });
}

function rejectInvalidFixOptions(options: CheckOptionValues): string | undefined {
  return fixOptionRejection({
    dryRun: options.dryRun,
    fix: options.fix,
    interactive: options.interactive,
    stdinTerminal: isTerminal(options.stdin),
    stdoutTerminal: isTerminal(options.stdout),
    yes: options.yes,
  });
}

function rejectInvalidJsonOptions(options: CheckOptionValues): string | undefined {
  if (options.jsonVersion !== undefined && !options.json) {
    return "--json-version only means something with --json. Add --json, or drop it.";
  }
  if (options.jsonVersion !== undefined && options.jsonVersion !== "1") {
    return `unsupported --json-version: ${safe(options.jsonVersion)}. Supported versions: 1`;
  }
  return undefined;
}
