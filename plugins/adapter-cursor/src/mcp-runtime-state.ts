import type { CursorMcpRuntimeState } from "./contract.js";

// oxlint-disable no-control-regex -- Cursor emits terminal escape sequences that must be removed.
const ANSI_PATTERN = new RegExp(
  "\\u001B(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007]*(?:\\u0007|\\u001B\\\\))",
  "gu",
);
// oxlint-enable no-control-regex
/**
 * One `name: status` row.
 *
 * The name is anything up to the first colon rather than a character class, because an MCP server
 * name is a JSON object key: `My Server` and non-ASCII names are ordinary, and a pattern that
 * rejected them dropped those servers from the result entirely — reporting nothing for a server
 * that needs approval, which is the failure this whole file exists to prevent. Rows that are not
 * servers at all match too; the check discards any name it did not find in the configuration.
 */
const SERVER_STATUS_PATTERN = /^(.+?):\s*(.+)$/u;
/** `already` and `not ready` both contain `ready`, so the word has to stand alone to count. */
const READY_PATTERN = /\bready\b/u;
/** Longest plausible server name, so a stray line of prose cannot become a metadata key. */
const MAX_NAME_LENGTH = 128;
/** Ceiling on recorded rows: the command's output is third-party text with a 10MB cap of its own. */
const MAX_SERVERS = 200;

/** Parses the terminal-oriented table emitted by `cursor-agent mcp list`. */
export function parseCursorMcpRuntimeStates(
  output: string,
): Readonly<Record<string, CursorMcpRuntimeState>> {
  const states: Record<string, CursorMcpRuntimeState> = {};
  const lines = output
    .replace(ANSI_PATTERN, "")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    const match = SERVER_STATUS_PATTERN.exec(line);
    const name = match?.[1];
    const statusText = match?.[2]?.toLowerCase();
    if (name === undefined || statusText === undefined || name.length > MAX_NAME_LENGTH) {
      continue;
    }
    if (!Object.hasOwn(states, name) && Object.keys(states).length >= MAX_SERVERS) {
      continue;
    }

    states[name] = classifyStatus(statusText);
  }

  return Object.freeze(states);
}

/**
 * Maps one status cell onto a state.
 *
 * Every failing phrase is tested before `ready`, because several of them contain it: `not ready`
 * and `failed to become ready` read as healthy under a plain substring test, and `ready` is the
 * one state that produces no finding. An unrecognized cell is `unknown` rather than `ready` for
 * the same reason — this check may not guess in the direction of silence.
 */
function classifyStatus(statusText: string): CursorMcpRuntimeState {
  if (statusText.includes("needs approval") || statusText.includes("not loaded")) {
    return "needs-approval";
  }
  if (statusText.includes("disabled")) {
    return "disabled";
  }
  if (
    statusText.includes("error") ||
    statusText.includes("failed") ||
    statusText.includes("disconnected") ||
    statusText.includes("not ready")
  ) {
    return "error";
  }
  if (READY_PATTERN.test(statusText)) {
    return "ready";
  }
  return "unknown";
}
