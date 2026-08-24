import type { CliCommandDefinition } from "./types.js";

/**
 * Validation for distribution-registered commands.
 *
 * Every problem across every definition is collected and reported in one error — mirroring the
 * plugin registry — so a distribution with several mistakes is fixed in one pass. A bad definition
 * is a build-time composition bug, so the run fails at startup as an operational failure rather
 * than shadowing a built-in or misparsing at run time.
 */

/**
 * Words the built-in commands and the command framework already answer to.
 *
 * `update` is reserved unconditionally: it registers only in a standalone distribution, and a
 * command word that parses in one build and collides in another is worse than a build-time refusal.
 */
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  "check",
  "help",
  "setup",
  "undo",
  "update",
  "version",
]);

/** `--help` is claimed by the framework; `--no-color` is consumed before any command parses. */
const RESERVED_FLAGS: ReadonlySet<string> = new Set(["--help", "--no-color"]);

const WORD_PATTERN = /^[a-z][a-z0-9-]{0,23}$/u;
const FLAG_PATTERN = /^--[a-z][a-z0-9-]{0,31}$/u;

/** Formats the collected problems as the startup failure message, or undefined when there are none. */
export function formatDistroCommandProblems(
  commands: readonly CliCommandDefinition[],
): string | undefined {
  const problems = distroCommandProblems(commands);
  if (problems.length === 0) {
    return undefined;
  }
  const heading =
    problems.length === 1
      ? "Aura cannot register the distribution's commands:"
      : `Aura cannot register the distribution's commands (${String(problems.length)} problems):`;
  return [heading, ...problems.map((problem) => `  - ${problem}`)].join("\n");
}

/** Every problem in the distribution's command list, one message per mistake. */
export function distroCommandProblems(commands: readonly CliCommandDefinition[]): string[] {
  const problems: string[] = [];
  const claimedWords = new Set<string>();
  for (const command of commands) {
    const label = `Command "${command.word}"`;
    if (!WORD_PATTERN.test(command.word)) {
      problems.push(
        `${label} must be a lowercase kebab-case word of at most 24 characters, starting with a letter.`,
      );
    } else if (RESERVED_WORDS.has(command.word)) {
      problems.push(`${label} claims a reserved command word.`);
    } else if (claimedWords.has(command.word)) {
      problems.push(`${label} is declared more than once.`);
    } else {
      claimedWords.add(command.word);
    }
    problems.push(...flagProblems(command, label));
  }
  return problems;
}

function flagProblems(command: CliCommandDefinition, label: string): string[] {
  const problems: string[] = [];
  const claimedFlags = new Set<string>();
  for (const flag of command.flags ?? []) {
    if (!FLAG_PATTERN.test(flag.flag)) {
      problems.push(
        `${label} flag "${flag.flag}" must be a lowercase kebab-case long flag such as --tag.`,
      );
    } else if (RESERVED_FLAGS.has(flag.flag)) {
      problems.push(`${label} flag "${flag.flag}" claims a reserved flag.`);
    } else if (claimedFlags.has(flag.flag)) {
      problems.push(`${label} flag "${flag.flag}" is declared more than once.`);
    } else {
      claimedFlags.add(flag.flag);
    }
  }
  return problems;
}
