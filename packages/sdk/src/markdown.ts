const INDENTED_CODE_COLUMNS = 4;
const TAB_STOP = 4;
const LIST_MARKER_PATTERN = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/u;

/** Replaces Markdown code with spaces while preserving offsets and line boundaries. */
export function maskMarkdownCode(content: string): string {
  const characters = content.split("");
  const indentedCode = findIndentedCodeLines(content);
  let fence: "```" | "~~~" | undefined;

  for (let index = 0; index < characters.length;) {
    const marker = content.slice(index, index + 3);
    if (fence !== undefined) {
      if (marker === fence && isLineStart(content, index)) {
        fence = undefined;
      }
      index = maskUntilLineEnd(characters, content, index);
      continue;
    }
    if (indentedCode.has(index)) {
      index = maskUntilLineEnd(characters, content, index);
      continue;
    }
    if ((marker === "```" || marker === "~~~") && isLineStart(content, index)) {
      fence = marker;
      index = maskUntilLineEnd(characters, content, index);
      continue;
    }
    if (characters[index] === "`") {
      index = maskInlineCode(characters, content, index);
      continue;
    }
    index += 1;
  }

  return characters.join("");
}

/**
 * Start offsets of the lines Markdown reads as an indented code block.
 *
 * Indentation on its own does not make a line code. Four spaces cannot interrupt a paragraph, and
 * inside a list they are simply how a nested item or a continuation line is written — the guidance
 * these documents are made of. So the threshold moves with the enclosing list item, and only a
 * line that opens a fresh block can qualify.
 */
function findIndentedCodeLines(content: string): ReadonlySet<number> {
  const starts = new Set<number>();
  let offset = 0;
  let fence: string | undefined;
  let listColumn = 0;
  let opensBlock = true;

  for (const line of content.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    const body = line.trim();
    if (body.length === 0) {
      opensBlock = true;
      continue;
    }
    if (fence !== undefined) {
      fence = body.startsWith(fence) ? undefined : fence;
    } else if (body.startsWith("```") || body.startsWith("~~~")) {
      fence = body.slice(0, 3);
    } else {
      const scan = scanBlockLine(line, listColumn, opensBlock);
      listColumn = scan.listColumn;
      if (scan.isCode) {
        starts.add(start);
      }
    }
    opensBlock = false;
  }

  return starts;
}

interface BlockScan {
  readonly isCode: boolean;
  readonly listColumn: number;
}

/** Classifies one line against the list enclosing it, for lines no fence already claimed. */
function scanBlockLine(line: string, listColumn: number, opensBlock: boolean): BlockScan {
  const column = indentColumn(line);
  const enclosing = Math.min(listColumn, column);
  const marker = LIST_MARKER_PATTERN.exec(line.trimStart());
  return marker === null
    ? {
        isCode: opensBlock && column >= enclosing + INDENTED_CODE_COLUMNS,
        listColumn: enclosing,
      }
    : { isCode: false, listColumn: column + marker[0].length };
}

function indentColumn(line: string): number {
  let column = 0;
  for (const character of line) {
    if (character === " ") {
      column += 1;
      continue;
    }
    if (character !== "\t") {
      break;
    }
    column += TAB_STOP - (column % TAB_STOP);
  }
  return column;
}

function isLineStart(content: string, index: number): boolean {
  const lineStart = content.lastIndexOf("\n", index - 1) + 1;
  return content.slice(lineStart, index).trim().length === 0;
}

function maskUntilLineEnd(characters: string[], content: string, start: number): number {
  const end = content.indexOf("\n", start);
  const limit = end === -1 ? content.length : end;
  maskRange(characters, start, limit);
  return end === -1 ? content.length : end + 1;
}

function maskInlineCode(characters: string[], content: string, start: number): number {
  let ticks = 1;
  while (content[start + ticks] === "`") {
    ticks += 1;
  }
  const delimiter = "`".repeat(ticks);
  const end = content.indexOf(delimiter, start + ticks);
  const limit = end === -1 ? start + ticks : end + ticks;
  maskRange(characters, start, limit);
  return limit;
}

function maskRange(characters: string[], start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== "\n" && characters[index] !== "\r") {
      characters[index] = " ";
    }
  }
}
