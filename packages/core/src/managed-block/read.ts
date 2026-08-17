import {
  handleMarkerInsideBlock,
  handleMarkerInsideSnippet,
  handleMarkerOutsideBlock,
} from "./marker-handlers.js";
import { type Marker, parseMarker } from "./markers.js";
import { addProblem, type OpenBlock, type OpenSnippet } from "./parse-state.js";
import { AURA_MANAGED_BLOCK_NOTICE } from "./protocol.js";
import {
  advanceMarkdownFence,
  type MarkdownFence,
  splitSourceLines,
  type SourceLine,
} from "./source-lines.js";
import type {
  ManagedBlock,
  ManagedBlockNote,
  ManagedBlockProblem,
  ManagedBlockReadResult,
} from "./types.js";

interface ReadState {
  block: OpenBlock | undefined;
  readonly blocks: ManagedBlock[];
  fence: MarkdownFence | undefined;
  readonly notes: ManagedBlockNote[];
  readonly problems: ManagedBlockProblem[];
  snippet: OpenSnippet | undefined;
  /** First marker hidden by the fence that is currently open, cleared whenever a fence closes. */
  suppressedMarkerLine: number | undefined;
}

/** Parses the single Aura-managed block in a source string without touching the filesystem. */
export function readManagedBlock(source: string): ManagedBlockReadResult {
  const state: ReadState = {
    block: undefined,
    blocks: [],
    fence: undefined,
    notes: [],
    problems: [],
    snippet: undefined,
    suppressedMarkerLine: undefined,
  };

  for (const line of splitSourceLines(source)) {
    processSourceLine(state, line, source);
  }

  return finishRead(state);
}

function processSourceLine(state: ReadState, line: SourceLine, source: string): void {
  const protectedByFence = advanceFenceState(state, line);
  const marker = protectedByFence ? undefined : parseMarker(line.text);

  if (marker === undefined) {
    collectPlainLine(source, line, protectedByFence, state.block, state.snippet, state.notes);
    return;
  }
  if (state.block === undefined) {
    state.block = handleMarkerOutsideBlock(marker, line, state.blocks, state.problems);
    return;
  }
  applyMarkerInsideBlock(state, state.block, marker, line, source);
}

/** Advances fence state, remembering the first marker the currently open fence is hiding. */
function advanceFenceState(state: ReadState, line: SourceLine): boolean {
  const previousFence = state.fence;
  state.fence = advanceMarkdownFence(line.text, state.fence);

  if (state.fence === undefined) {
    state.suppressedMarkerLine = undefined;
    return previousFence !== undefined;
  }
  if (state.suppressedMarkerLine === undefined && line.text.startsWith("<!-- aura:")) {
    state.suppressedMarkerLine = line.number;
  }
  return true;
}

function applyMarkerInsideBlock(
  state: ReadState,
  block: OpenBlock,
  marker: Marker,
  line: SourceLine,
  source: string,
): void {
  block.acceptsNotice = false;
  if (marker.kind === "block-begin") {
    addProblem(
      state.problems,
      "nested-block",
      line.number,
      "Aura managed blocks cannot be nested.",
    );
    return;
  }
  if (state.snippet === undefined) {
    const outcome = handleMarkerInsideBlock(marker, line, block, state.problems);
    closeBlockIfEnded(state, outcome.closed);
    state.snippet = outcome.snippet;
    return;
  }

  const outcome = handleMarkerInsideSnippet(
    marker,
    line,
    block,
    state.snippet,
    source,
    state.problems,
  );
  closeBlockIfEnded(state, outcome.closedBlock);
  state.snippet = outcome.snippet;
}

function closeBlockIfEnded(state: ReadState, closed: ManagedBlock | undefined): void {
  if (closed !== undefined) {
    state.blocks.push(closed);
    state.block = undefined;
  }
}

function finishRead(state: ReadState): ManagedBlockReadResult {
  if (state.fence !== undefined && state.suppressedMarkerLine !== undefined) {
    state.notes.push(
      Object.freeze({
        code: "unterminated-fence",
        line: state.suppressedMarkerLine,
        message:
          "An unclosed Markdown fence made this Aura marker ordinary text. Close the fence if the marker was meant to be read.",
      }),
    );
  }
  if (state.snippet !== undefined) {
    addProblem(
      state.problems,
      "incomplete-snippet",
      state.snippet.startLine,
      `Snippet "${state.snippet.id}" has no closing marker.`,
    );
  }
  if (state.block !== undefined) {
    addProblem(
      state.problems,
      "incomplete-outer-block",
      state.block.start.number,
      "Aura managed block has no closing marker.",
    );
  }

  const frozenNotes = Object.freeze(state.notes);
  if (state.problems.length > 0) {
    return {
      notes: frozenNotes,
      problems: Object.freeze(state.problems),
      status: "invalid",
    };
  }
  const managedBlock = state.blocks[0];
  return managedBlock === undefined
    ? { notes: frozenNotes, status: "absent" }
    : { block: managedBlock, notes: frozenNotes, status: "present" };
}

function collectPlainLine(
  source: string,
  line: SourceLine,
  protectedByFence: boolean,
  block: OpenBlock | undefined,
  snippet: OpenSnippet | undefined,
  notes: ManagedBlockNote[],
): void {
  if (block === undefined || snippet !== undefined) {
    return;
  }
  if (!protectedByFence && block.acceptsNotice && line.text === AURA_MANAGED_BLOCK_NOTICE) {
    block.acceptsNotice = false;
    return;
  }

  block.acceptsNotice = false;
  block.unmanaged.push(source.slice(line.start, line.end));
  notes.push(
    Object.freeze({
      code: "unmanaged-content",
      line: line.number,
      message: "Content outside a tagged snippet will be moved below the Aura block.",
    }),
  );
}
