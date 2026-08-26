/**
 * Recognizes validation commands — the runs that tell an agent whether its work is green.
 *
 * The vocabulary is a bounded allowlist on purpose: a wrong `true` would count ordinary work as
 * validation and skew every derived metric, so only unambiguous test/lint/build/typecheck shapes
 * qualify and everything else stays `false`.
 */

/** Executables that are themselves validation runs, with or without arguments. */
const VALIDATION_COMMANDS = new Set([
  "eslint",
  "jest",
  "mypy",
  "oxfmt",
  "oxlint",
  "pytest",
  "ruff",
  "tsc",
  "vitest",
]);

/** Subcommands that mean validation regardless of the executable that routes to them. */
const VALIDATION_SUBCOMMANDS = new Set([
  "build",
  "check",
  "lint",
  "test",
  "typecheck",
  "verify",
  "vet",
]);

/** Script-name prefixes (`test:unit`, `lint:fix`) and the `format:check` shape. */
const VALIDATION_PREFIXES = ["build:", "check:", "lint:", "test:", "typecheck:", "verify:"];

export function isValidationIdentity(
  command: string | undefined,
  subcommand: string | undefined,
): boolean {
  if (command === undefined) {
    return false;
  }
  if (VALIDATION_COMMANDS.has(command)) {
    return true;
  }
  if (subcommand === undefined) {
    return false;
  }
  if (VALIDATION_SUBCOMMANDS.has(subcommand) || subcommand.endsWith(":check")) {
    return true;
  }
  return VALIDATION_PREFIXES.some((prefix) => subcommand.startsWith(prefix));
}
