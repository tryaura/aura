import { canonicalizeContent } from "../content-hash.js";

/**
 * Appends Markdown fragments while preserving every existing byte.
 *
 * Only appended fragments are canonicalized, and by the same normalization the content hash
 * covers — that is what lets a recorded fingerprint answer for text already in the file. They use
 * the target's line ending and end in one line ending, with one blank-line seam between
 * consecutive fragments.
 */
export function appendInstructionFragments(source: string, fragments: readonly string[]): string {
  if (fragments.length === 0) {
    return source;
  }
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
  let result = source;
  for (const fragment of fragments) {
    const canonical = canonicalizeContent(fragment).replaceAll("\n", lineEnding);
    if (result.length > 0) {
      result += blankLineSeparator(result, lineEnding);
    }
    result += canonical;
  }
  return result;
}

function blankLineSeparator(source: string, lineEnding: string): string {
  let trailingLineEndings = 0;
  let end = source.length;
  while (end > 0 && trailingLineEndings < 2) {
    if (source.endsWith("\r\n", end)) {
      end -= 2;
      trailingLineEndings += 1;
      continue;
    }
    if (source[end - 1] === "\n" || source[end - 1] === "\r") {
      end -= 1;
      trailingLineEndings += 1;
      continue;
    }
    break;
  }
  return lineEnding.repeat(2 - trailingLineEndings);
}
