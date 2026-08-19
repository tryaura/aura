import { rejectInvalidPathOptions } from "./command-support.js";
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
  readonly verbose: boolean;
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
    rejectInvalidVerboseOptions(options) ??
    rejectInvalidFixOptions(options) ??
    rejectInvalidExplainOptions(options) ??
    rejectInvalidPathOptions(options.home, options.pathValue)
  );
}

function rejectInvalidVerboseOptions(options: CheckOptionValues): string | undefined {
  if (options.verbose && options.json) {
    return "--verbose cannot be combined with --json; JSON already includes every reported field.";
  }
  if (options.verbose && options.explaining) {
    return "--verbose cannot be combined with --explain; an explanation already targets one check.";
  }
  return undefined;
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
