import type { CursorMcpRuntimeState } from "@tryaura/adapter-cursor";

/** A state Cursor reports that a user can do something about. */
export type ActionableCursorState = Exclude<CursorMcpRuntimeState, "ready" | "unknown">;

/** Every user-facing string one Cursor runtime state produces. */
export interface CursorStateAction {
  /** Stable guided-choice identifier. */
  readonly choiceId: string;
  /** Short user-facing action label. */
  readonly choiceLabel: string;
  /** What to do about it, shown as both finding detail and the plan's first manual step. */
  readonly guidance: (name: string) => string;
  /** One sentence naming the problem. */
  readonly message: (name: string, displayName: string) => string;
  /** One line naming what selecting the choice accomplishes. */
  readonly summary: (name: string) => string;
}

/**
 * One row per state, rather than the same three-way branch spelled out for each string.
 *
 * The five strings a state needs were previously five parallel ternaries in two functions, so
 * adding a state meant finding all of them and nothing made them agree. Keyed by state, the
 * compiler requires the row and the lookups cannot drift.
 */
export const CURSOR_STATE_ACTIONS: Readonly<Record<ActionableCursorState, CursorStateAction>> =
  Object.freeze({
    disabled: {
      choiceId: "enable-in-cursor",
      choiceLabel: "Enable in Cursor",
      guidance: (name) => `Open Cursor, open MCP settings, and enable server ${name}.`,
      message: (name, displayName) => `MCP server ${name} is disabled in ${displayName}.`,
      summary: (name) => `Enable MCP server ${name} in Cursor.`,
    },
    error: {
      choiceId: "repair-in-cursor",
      choiceLabel: "Repair in Cursor",
      guidance: (name) =>
        `Open Cursor's MCP settings, inspect the connection error for server ${name}, and repair its configuration or service.`,
      message: (name, displayName) =>
        `MCP server ${name} in ${displayName} cannot be reached because Cursor reported a connection error.`,
      summary: (name) => `Repair MCP server ${name} in Cursor.`,
    },
    "needs-approval": {
      choiceId: "approve-in-cursor",
      choiceLabel: "Approve in Cursor",
      guidance: (name) => `Open Cursor, open MCP settings, and approve server ${name}.`,
      message: (name, displayName) => `MCP server ${name} in ${displayName} needs approval.`,
      summary: (name) => `Approve MCP server ${name} in Cursor.`,
    },
  });
