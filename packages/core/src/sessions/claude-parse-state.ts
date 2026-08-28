import { createParseState } from "./session-parse-initialize.js";
import type { ParseState } from "./session-parse-state.js";
import type { SessionDetailLevel } from "./session-detail-metrics.js";

/**
 * Claude Code additions to the shared parse accumulator.
 *
 * Everything a Codex parse tracks is tracked here through the same {@link ParseState}; these
 * fields exist only for signals Claude Code records differently: streamed assistant messages
 * that repeat one usage object across lines, structural edit results, and turns that have no
 * explicit boundary events.
 */
export interface ClaudeParseState extends ParseState {
  /** Whether a prompt has opened a turn that no later prompt has closed yet. */
  activeTurn: boolean;
  /** Distinct files named by successful Edit/Write calls. */
  readonly editedFiles: Set<string>;
  /** The last non-null `stop_reason` seen since the current turn opened. */
  lastStopReason: string | undefined;
  /** File paths of in-flight Edit/Write calls, keyed by `tool_use` id. */
  readonly pendingEditFiles: Map<string, string>;
  /** Assistant message ids whose usage was already counted; streamed lines repeat it. */
  readonly seenMessageIds: Set<string>;
  /** Prompts a person typed; every one after the first is a reprompt intervention. */
  typedPrompts: number;
}

/** Fresh mutable state for one bounded Claude Code transcript fold. */
export function createClaudeParseState(detail: SessionDetailLevel): ClaudeParseState {
  return {
    ...createParseState(detail),
    activeTurn: false,
    editedFiles: new Set(),
    lastStopReason: undefined,
    pendingEditFiles: new Map(),
    seenMessageIds: new Set(),
    typedPrompts: 0,
  };
}
