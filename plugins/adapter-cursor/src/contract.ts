import { extname } from "node:path";

import { isConfigRecord, type AppModel, type InstructionDocument } from "@tryaura/aura-sdk";

/**
 * The names this adapter puts into the workspace model, published for checks to read.
 *
 * A check that reached for these as string literals would keep compiling after a rename here and
 * silently stop finding anything, so the contract is exported and imported rather than retyped.
 *
 * `rulesProject` names the `.cursor/rules` directory slot; each discovered child file gets a
 * derived id of the form `cursor.rules.project/<encoded-name>`, and `aura` is the derived id
 * reserved for the rule Aura itself maintains there.
 */
export const CURSOR_SOURCE_IDS = Object.freeze({
  agents: "cursor.rules.project.agents",
  aura: "cursor.rules.project/aura-owned",
  legacyRules: "cursor.rules.project.legacy",
  mcpGlobal: "cursor.mcp.global",
  mcpProject: "cursor.mcp.project",
  rulesProject: "cursor.rules.project",
});

export const CURSOR_ADAPTER_ID = "cursor";

/**
 * Metadata keys carrying what `cursor-agent mcp list` reported.
 *
 * Internal on purpose, and not re-exported from the package entry point: a consumer that reached
 * for the key would index detection metadata straight, skipping the validation the readers below
 * apply to a value a third-party CLI produced.
 */
const STATES_KEY = "mcpRuntimeStates";
const UNAVAILABLE_KEY = "mcpRuntimeStatesUnavailable";

/** Whether Cursor loaded one configured MCP server. */
export type CursorMcpRuntimeState = "ready" | "needs-approval" | "disabled" | "error" | "unknown";

/** Why Cursor's runtime states are missing, when the CLI was present and the command still failed. */
export type CursorMcpStateUnavailableReason = "timeout" | "failed";

/** Detection metadata describing one `cursor-agent mcp list` outcome. */
export type CursorMcpStateMetadata =
  | { readonly [STATES_KEY]: Readonly<Record<string, CursorMcpRuntimeState>> }
  | { readonly [UNAVAILABLE_KEY]: CursorMcpStateUnavailableReason };

/** Reads and validates the Cursor CLI's per-server MCP runtime states from detection metadata. */
export function readCursorMcpRuntimeStates(
  app: AppModel,
): Readonly<Record<string, CursorMcpRuntimeState>> | undefined {
  const value = app.detection.metadata?.[STATES_KEY];
  if (!isConfigRecord(value)) {
    return undefined;
  }

  const states: Record<string, CursorMcpRuntimeState> = {};
  for (const [name, state] of Object.entries(value)) {
    if (isCursorMcpRuntimeState(state)) {
      states[name] = state;
    }
  }
  return Object.freeze(states);
}

/**
 * Reads why the runtime states are absent, when Aura ran the command and got nothing usable.
 *
 * `undefined` covers both "the states are here" and "nothing ran", which are the two outcomes with
 * nothing to tell the user: an uninstalled companion CLI is the ordinary case, not a fault.
 */
export function readCursorMcpStateUnavailable(
  app: AppModel,
): CursorMcpStateUnavailableReason | undefined {
  const value = app.detection.metadata?.[UNAVAILABLE_KEY];
  return value === "timeout" || value === "failed" ? value : undefined;
}

/** Builds the metadata a successful listing contributes. */
export function cursorMcpStatesMetadata(
  states: Readonly<Record<string, CursorMcpRuntimeState>>,
): CursorMcpStateMetadata {
  return { [STATES_KEY]: states };
}

/** Builds the metadata a failed listing contributes. */
export function cursorMcpUnavailableMetadata(
  reason: CursorMcpStateUnavailableReason,
): CursorMcpStateMetadata {
  return { [UNAVAILABLE_KEY]: reason };
}

function isCursorMcpRuntimeState(value: unknown): value is CursorMcpRuntimeState {
  return (
    value === "ready" ||
    value === "needs-approval" ||
    value === "disabled" ||
    value === "error" ||
    value === "unknown"
  );
}

/**
 * Whether Cursor attaches this rule only conditionally rather than in every conversation.
 *
 * Cursor always-loads an `.mdc` rule only when its frontmatter opts in with `alwaysApply: true`;
 * every other rule attaches by description or glob. Which frontmatter means what is this adapter's
 * knowledge, so the predicate is published here for checks that reason about what is actually
 * loaded, instead of each check re-reading Cursor's frontmatter rules for itself.
 */
export function isConditionalCursorRule(document: InstructionDocument): boolean {
  return (
    extname(document.path).toLowerCase() === ".mdc" && document.metadata?.["alwaysApply"] !== true
  );
}
