import type { CursorMcpRuntimeState } from "@tryaura/adapter-cursor";

/** A state Cursor reports that a user can do something about. */
export type ActionableCursorState = Exclude<CursorMcpRuntimeState, "ready" | "unknown">;

/** Every user-facing string one Cursor runtime state produces. */
export interface CursorStateAction {
  /** What the user has to do about it in Cursor, shown as the finding's detail. */
  readonly guidance: (name: string) => string;
  /** One sentence naming the problem. */
  readonly message: (name: string, displayName: string) => string;
}

/**
 * One row per state, rather than the same three-way branch spelled out for each string.
 *
 * The strings a state needs were previously parallel ternaries in two functions, so adding a state
 * meant finding all of them and nothing made them agree. Keyed by state, the compiler requires the
 * row and the lookups cannot drift.
 */
export const CURSOR_STATE_ACTIONS: Readonly<Record<ActionableCursorState, CursorStateAction>> =
  Object.freeze({
    disabled: {
      guidance: (name) => `Open Cursor, open MCP settings, and enable server ${name}.`,
      message: (name, displayName) => `MCP server ${name} is disabled in ${displayName}.`,
    },
    error: {
      guidance: (name) =>
        `Open Cursor's MCP settings, inspect the connection error for server ${name}, and repair its configuration or service.`,
      message: (name, displayName) =>
        `MCP server ${name} in ${displayName} cannot be reached because Cursor reported a connection error.`,
    },
    "needs-approval": {
      guidance: (name) => `Open Cursor, open MCP settings, and approve server ${name}.`,
      message: (name, displayName) => `MCP server ${name} in ${displayName} needs approval.`,
    },
  });
