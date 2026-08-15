/** Replaces Markdown code with spaces while preserving offsets and line boundaries. */
export function maskMarkdownCode(content: string): string {
  const characters = content.split("");
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
