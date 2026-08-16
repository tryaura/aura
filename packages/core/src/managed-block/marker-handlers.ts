import type { Marker } from "./markers.js";
import {
  addProblem,
  closeBlock,
  closeSnippet,
  collectMarkerValidation,
  type OpenBlock,
  type OpenSnippet,
} from "./parse-state.js";
import type { SourceLine } from "./source-lines.js";
import type { ManagedBlock, ManagedBlockProblem } from "./types.js";

export function handleMarkerOutsideBlock(
  marker: Marker,
  line: SourceLine,
  blocks: readonly ManagedBlock[],
  problems: ManagedBlockProblem[],
): OpenBlock | undefined {
  if (marker.kind === "block-begin") {
    if (blocks.length > 0) {
      addProblem(
        problems,
        "duplicate-block",
        line.number,
        "Aura files may contain only one managed block.",
      );
    }
    return { acceptsNotice: true, snippets: [], snippetIds: new Set(), start: line, unmanaged: [] };
  }
  if (marker.kind === "block-end") {
    addProblem(
      problems,
      "orphan-outer-end",
      line.number,
      "Found an Aura outer end marker without a matching begin marker.",
    );
  } else if (marker.kind === "malformed") {
    addProblem(problems, "malformed-marker", line.number, "Found a malformed Aura marker.");
  } else {
    collectMarkerValidation(marker, line, problems);
    addProblem(
      problems,
      "orphan-snippet-marker",
      line.number,
      "Found an Aura snippet marker outside a managed block.",
    );
  }
  return undefined;
}

export interface BlockMarkerOutcome {
  readonly closed?: ManagedBlock | undefined;
  readonly snippet?: OpenSnippet | undefined;
}

export function handleMarkerInsideBlock(
  marker: Marker,
  line: SourceLine,
  block: OpenBlock,
  problems: ManagedBlockProblem[],
): BlockMarkerOutcome {
  if (marker.kind === "block-end") {
    return { closed: closeBlock(block, line) };
  }
  if (marker.kind === "snippet-begin") {
    collectMarkerValidation(marker, line, problems);
    if (block.snippetIds.has(marker.id)) {
      addProblem(
        problems,
        "duplicate-snippet",
        line.number,
        `Snippet ID "${marker.id}" appears more than once in the managed block.`,
      );
    }
    block.snippetIds.add(marker.id);
    return {
      snippet: {
        contentStart: line.end,
        id: marker.id,
        startLine: line.number,
        startOffset: line.start,
        storedHash: marker.hash,
      },
    };
  } else if (marker.kind === "snippet-end") {
    collectMarkerValidation(marker, line, problems);
    addProblem(
      problems,
      "orphan-snippet-marker",
      line.number,
      "Found a snippet end marker without a matching begin marker.",
    );
  } else {
    addProblem(problems, "malformed-marker", line.number, "Found a malformed Aura marker.");
  }
  return {};
}

export interface SnippetMarkerOutcome {
  readonly closedBlock?: ManagedBlock | undefined;
  readonly snippet?: OpenSnippet | undefined;
}

export function handleMarkerInsideSnippet(
  marker: Marker,
  line: SourceLine,
  block: OpenBlock,
  snippet: OpenSnippet,
  source: string,
  problems: ManagedBlockProblem[],
): SnippetMarkerOutcome {
  if (marker.kind === "snippet-end") {
    collectMarkerValidation(marker, line, problems);
    if (marker.id !== snippet.id) {
      addProblem(
        problems,
        "mismatched-snippet-end",
        line.number,
        `Snippet "${snippet.id}" ends with marker for "${marker.id}".`,
      );
    }
    block.snippets.push(closeSnippet(snippet, line, source));
    return {};
  }
  if (marker.kind === "block-end") {
    addProblem(
      problems,
      "outer-end-before-snippet-end",
      line.number,
      `Outer block ends before snippet "${snippet.id}" closes.`,
    );
    return { closedBlock: closeBlock(block, line) };
  }
  if (marker.kind === "snippet-begin") {
    collectMarkerValidation(marker, line, problems);
    addProblem(
      problems,
      "nested-snippet",
      line.number,
      `Snippet "${marker.id}" begins before snippet "${snippet.id}" ends.`,
    );
  } else {
    addProblem(problems, "malformed-marker", line.number, "Found a malformed Aura marker.");
  }
  return { snippet };
}
