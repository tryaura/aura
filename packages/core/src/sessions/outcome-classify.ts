import { shellSubcommand } from "./command-identity.js";
import type { OutcomeConfidence, OutcomeKind, ShellBatchComponent } from "./session-metrics.js";
import { asString, parseTranscriptRecord } from "./transcript-json.js";

export interface OutcomeClassification {
  readonly confidence: OutcomeConfidence;
  readonly kind: OutcomeKind;
  readonly reason: string;
}

interface ShellOutcomeIdentity {
  readonly command: string | undefined;
  readonly label: string;
}

interface ShellIdentity extends ShellOutcomeIdentity {
  readonly batchComponents: readonly ShellBatchComponent[] | undefined;
}

const COMPOUND_SHELL = /(?:[\r\n]|&&|\|\||[;|])/u;
const BATCH_COMPONENT_LIMIT = 12;
const COMMAND_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9+._-]{0,63}$/u;
const DOUBLE_CHARACTER_SEPARATORS = new Set(["\r\n", "&&", "||"]);
const SINGLE_CHARACTER_SEPARATORS = new Set(["\r", "\n", ";", "|"]);
const SHELL_RESERVED_WORDS = new Set([
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "select",
  "then",
  "time",
  "until",
  "while",
]);
const CHECK_OUTPUT = /(?:\bTest Files\b[\s\S]*\bTests\b|\btests? failed\b|\bFAIL\s+[^\n]+)/iu;
const PENDING_CHECK = /\tpending\t/u;
const SHELL_ERROR = /(?:no such file|permission denied|command not found|\berror:)/iu;

/** Extracts a privacy-safe identity from Codex's JSON-encoded `{cmd}` tool arguments. */
export function shellIdentity(rawArguments: unknown): ShellIdentity {
  const raw = asString(rawArguments);
  return shellIdentityFromCommand(
    raw === undefined ? undefined : asString(parseTranscriptRecord(raw)?.["cmd"]),
  );
}

/** Extracts a privacy-safe identity without pretending a shell batch is its first command. */
export function shellIdentityFromCommand(command: string | undefined): ShellIdentity {
  if (command === undefined || command.trim() === "") {
    return { batchComponents: undefined, command: undefined, label: "shell" };
  }
  if (COMPOUND_SHELL.test(command)) {
    return { batchComponents: shellBatchComponents(command), command, label: "shell batch" };
  }
  const head = command.trimStart().split(/\s/u, 1)[0];
  if (head === undefined || head === "" || head.includes("=")) {
    return { batchComponents: undefined, command, label: "shell" };
  }
  return { batchComponents: undefined, command, label: head.split("/").pop() ?? "shell" };
}

/**
 * Extracts only top-level command heads from a compound shell call.
 *
 * This is deliberately conservative rather than a shell parser. Quoted text, comments, command
 * substitutions, and parenthesized groups never become component identities. Heredocs suppress
 * the breakdown entirely because their bodies are arbitrary transcript content.
 */
function shellBatchComponents(command: string): readonly ShellBatchComponent[] {
  const segments = topLevelShellSegments(command);
  if (segments === undefined) {
    return [];
  }
  const components: ShellBatchComponent[] = [];
  for (const segment of segments) {
    const component = shellBatchComponent(segment);
    if (component !== undefined) {
      components.push(component);
      if (components.length === BATCH_COMPONENT_LIMIT) {
        break;
      }
    }
  }
  return components;
}

function shellBatchComponent(segment: string): ShellBatchComponent | undefined {
  const head = segment.trimStart().split(/\s/u, 1)[0];
  if (head === undefined || head === "" || head.includes("=")) {
    return undefined;
  }
  const command = head.split("/").pop();
  if (command === undefined || !COMMAND_TOKEN.test(command) || SHELL_RESERVED_WORDS.has(command)) {
    return undefined;
  }
  return { command, subcommand: shellSubcommand(segment, command) };
}

/** Splits only control operators known to be outside shell quoting and nested groups. */
function topLevelShellSegments(command: string): readonly string[] | undefined {
  const segments: string[] = [];
  let start = 0;
  const state: ShellScanState = { parentheses: 0, quote: undefined };
  for (let index = 0; index < command.length; index += 1) {
    const action = scanShellCharacter(command, index, state);
    if (action.kind === "skip") {
      index += action.length - 1;
      continue;
    }
    if (action.kind === "heredoc") {
      return undefined;
    }
    if (action.kind === "comment") {
      const newline = command.indexOf("\n", index + 1);
      pushSegment(segments, command, start, index);
      if (newline < 0) {
        return segments;
      }
      start = newline + 1;
      index = newline;
      continue;
    }
    pushSegment(segments, command, start, index);
    start = index + action.length;
    index += action.length - 1;
  }
  pushSegment(segments, command, start, command.length);
  return segments;
}

type ShellQuote = "backtick" | "double" | "single";

interface ShellScanState {
  parentheses: number;
  quote: ShellQuote | undefined;
}

type ShellScanAction =
  | { readonly kind: "comment" }
  | { readonly kind: "heredoc" }
  | { readonly kind: "separator"; readonly length: number }
  | { readonly kind: "skip"; readonly length: number };

function scanShellCharacter(
  command: string,
  index: number,
  state: ShellScanState,
): ShellScanAction {
  const character = command[index];
  if (character === "\\") {
    return { kind: "skip", length: 2 };
  }
  if (consumeQuote(state, character)) {
    return { kind: "skip", length: 1 };
  }
  if (character === "<" && command[index + 1] === "<") {
    return { kind: "heredoc" };
  }
  if (consumeParenthesis(state, character) || state.parentheses > 0) {
    return { kind: "skip", length: 1 };
  }
  if (character === "#") {
    return { kind: "comment" };
  }
  const separatorLength = shellSeparatorLength(command, index);
  return separatorLength === 0
    ? { kind: "skip", length: 1 }
    : { kind: "separator", length: separatorLength };
}

function consumeQuote(state: ShellScanState, character: string | undefined): boolean {
  if (state.quote !== undefined) {
    if (character === closingQuote(state.quote)) {
      state.quote = undefined;
    }
    return true;
  }
  state.quote = openingQuote(character);
  return state.quote !== undefined;
}

function openingQuote(character: string | undefined): ShellQuote | undefined {
  if (character === "'") {
    return "single";
  }
  if (character === '"') {
    return "double";
  }
  return character === "`" ? "backtick" : undefined;
}

function closingQuote(quote: ShellQuote): string {
  if (quote === "single") {
    return "'";
  }
  return quote === "double" ? '"' : "`";
}

function consumeParenthesis(state: ShellScanState, character: string | undefined): boolean {
  if (character === "(") {
    state.parentheses += 1;
    return true;
  }
  if (character !== ")" || state.parentheses === 0) {
    return false;
  }
  state.parentheses -= 1;
  return true;
}

function shellSeparatorLength(command: string, index: number): number {
  if (DOUBLE_CHARACTER_SEPARATORS.has(command.slice(index, index + 2))) {
    return 2;
  }
  return SINGLE_CHARACTER_SEPARATORS.has(command[index] ?? "") ? 1 : 0;
}

function pushSegment(segments: string[], command: string, start: number, end: number): void {
  const segment = command.slice(start, end).trim();
  if (segment !== "") {
    segments.push(segment);
  }
}

/**
 * Classifies only protocols with strong local evidence; everything else stays unknown.
 *
 * The exit code is absent for sources that report failure structurally instead of echoing a
 * code (Claude Code's `is_error`); only the code-keyed protocols need it to fire.
 */
export function classifyShellOutcome(
  identity: ShellOutcomeIdentity,
  exitCode: number | undefined,
  output: string,
): OutcomeClassification {
  if (exitCode === 127) {
    return {
      confidence: "high",
      kind: "invocation_error",
      reason: "the shell reported that the executable was not found",
    };
  }
  if (identity.label === "gh" && exitCode === 8 && PENDING_CHECK.test(output)) {
    return {
      confidence: "high",
      kind: "pending_status",
      reason: "GitHub CLI reported checks still pending",
    };
  }
  if (CHECK_OUTPUT.test(output)) {
    return {
      confidence: "high",
      kind: "check_failure",
      reason: "a test runner executed and reported failing checks",
    };
  }
  if (
    (identity.label === "rg" || identity.label === "grep") &&
    exitCode === 1 &&
    !SHELL_ERROR.test(output)
  ) {
    return {
      confidence: "medium",
      kind: "no_match",
      reason: "the search command reported no matches",
    };
  }
  return {
    confidence: "low",
    kind: "unknown_nonzero",
    reason:
      identity.label === "shell batch"
        ? "a compound shell batch failed; the failing segment is not recorded"
        : exitCode === undefined
          ? "the tool reported a failure without a recognized outcome protocol"
          : "the command exited nonzero without a recognized outcome protocol",
  };
}
