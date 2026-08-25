import type { OutcomeConfidence, OutcomeKind } from "./session-metrics.js";
import { asString, parseTranscriptRecord } from "./transcript-json.js";

export interface OutcomeClassification {
  readonly confidence: OutcomeConfidence;
  readonly kind: OutcomeKind;
  readonly reason: string;
}

interface ShellIdentity {
  readonly command: string | undefined;
  readonly label: string;
}

const COMPOUND_SHELL = /(?:[\r\n]|&&|\|\||[;|])/u;
const CHECK_OUTPUT = /(?:\bTest Files\b[\s\S]*\bTests\b|\btests? failed\b|\bFAIL\s+[^\n]+)/iu;
const PENDING_CHECK = /\tpending\t/u;
const SHELL_ERROR = /(?:no such file|permission denied|command not found|\berror:)/iu;

/** Extracts a privacy-safe identity without pretending a shell batch is its first command. */
export function shellIdentity(rawArguments: unknown): ShellIdentity {
  const raw = asString(rawArguments);
  const command = raw === undefined ? undefined : asString(parseTranscriptRecord(raw)?.["cmd"]);
  if (command === undefined || command.trim() === "") {
    return { command: undefined, label: "shell" };
  }
  if (COMPOUND_SHELL.test(command)) {
    return { command, label: "shell batch" };
  }
  const head = command.trimStart().split(/\s/u, 1)[0];
  if (head === undefined || head === "" || head.includes("=")) {
    return { command, label: "shell" };
  }
  return { command, label: head.split("/").pop() ?? "shell" };
}

/** Classifies only protocols with strong local evidence; everything else stays unknown. */
export function classifyShellOutcome(
  identity: ShellIdentity,
  exitCode: number,
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
        ? "a compound shell batch exited nonzero; the failing segment is not recorded"
        : "the command exited nonzero without a recognized outcome protocol",
  };
}
