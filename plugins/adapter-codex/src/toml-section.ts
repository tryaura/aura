import { McpWriteError } from "@tryaura/aura-sdk";

/** Comment lines delimiting the only region of Codex's configuration Aura writes. */
export const MANAGED_BEGIN = "# aura:begin MCP";
export const MANAGED_END = "# aura:end MCP";

/**
 * Swaps the marker-delimited block Aura owns for `section`, leaving every other line as written.
 *
 * The markers are found by scanning TOML string state rather than by matching text, so a marker
 * spelled inside a multi-line string belongs to that string and not to Aura.
 */
export function replaceManagedSection(existing: string, section: string): string {
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = existing.endsWith("\n") || existing.length === 0;
  const lines = existing.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const range = managedRange(visibleMarkers(lines));
  const output =
    range === undefined ? appendSection(lines, section) : spliceSection(lines, section, range);
  const joined = output.join(eol);
  return joined + (trailingNewline && joined.length > 0 ? eol : "");
}

interface ManagedRange {
  readonly begin: number;
  readonly end: number;
}

function managedRange(markers: ReturnType<typeof visibleMarkers>): ManagedRange | undefined {
  if (markers.begin === undefined && markers.end === undefined) {
    return undefined;
  }
  if (
    markers.begin === undefined ||
    markers.end === undefined ||
    markers.begin >= markers.end ||
    markers.count !== 2 ||
    !markers.exact
  ) {
    throw new McpWriteError("Codex's Aura-managed MCP markers are malformed.");
  }
  return { begin: markers.begin, end: markers.end };
}

function appendSection(lines: readonly string[], section: string): string[] {
  const output = [...lines];
  if (section.length === 0) {
    return output;
  }
  if (output.length > 0 && output.at(-1) !== "") {
    output.push("");
  }
  output.push(...section.split("\n"));
  return output;
}

function spliceSection(lines: readonly string[], section: string, range: ManagedRange): string[] {
  const output = [
    ...lines.slice(0, range.begin),
    ...(section.length === 0 ? [] : section.split("\n")),
    ...lines.slice(range.end + 1),
  ];
  while (output.length > 0 && output.at(-1) === "") {
    output.pop();
  }
  return output;
}

// fallow-ignore-next-line complexity -- marker visibility is coupled to TOML quote state.
function visibleMarkers(lines: readonly string[]): {
  readonly begin?: number | undefined;
  readonly count: number;
  readonly end?: number | undefined;
  readonly exact: boolean;
} {
  let begin: number | undefined;
  let end: number | undefined;
  let count = 0;
  let exact = true;
  let multiline: "basic" | "literal" | undefined;
  for (const [index, line] of lines.entries()) {
    if (multiline === undefined) {
      const marker = markerOnLine(line);
      if (marker === "begin") {
        begin = begin ?? index;
        count += 1;
        exact &&= line === MANAGED_BEGIN;
      } else if (marker === "end") {
        end = end ?? index;
        count += 1;
        exact &&= line === MANAGED_END;
      }
    }
    multiline = nextMultilineState(line, multiline);
  }
  return {
    ...(begin === undefined ? {} : { begin }),
    count,
    exact,
    ...(end === undefined ? {} : { end }),
  };
}

function markerOnLine(line: string): "begin" | "end" | undefined {
  const candidate = line.trimStart();
  if (candidate.startsWith(MANAGED_BEGIN)) {
    return "begin";
  }
  return candidate.startsWith(MANAGED_END) ? "end" : undefined;
}

// fallow-ignore-next-line complexity -- TOML string state requires explicit quote transitions.
function nextMultilineState(
  line: string,
  initial: "basic" | "literal" | undefined,
): "basic" | "literal" | undefined {
  let state = initial;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const rest = line.slice(index);
    if (state === "basic") {
      if (!escaped && rest.startsWith('"""')) {
        state = undefined;
        index += 2;
      }
      escaped = !escaped && line[index] === "\\";
      if (line[index] !== "\\") {
        escaped = false;
      }
      continue;
    }
    if (state === "literal") {
      if (rest.startsWith("'''")) {
        state = undefined;
        index += 2;
      }
      continue;
    }
    if (rest.startsWith('"""')) {
      state = "basic";
      index += 2;
    } else if (rest.startsWith("'''")) {
      state = "literal";
      index += 2;
    } else if (line[index] === "#") {
      break;
    } else if (line[index] === '"') {
      index = skipQuoted(line, index, '"');
    } else if (line[index] === "'") {
      index = skipQuoted(line, index, "'");
    }
  }
  return state;
}

function skipQuoted(line: string, start: number, quote: '"' | "'"): number {
  let escaped = false;
  for (let index = start + 1; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"' && character === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if (character === quote && !escaped) {
      return index;
    }
    escaped = false;
  }
  return line.length;
}
