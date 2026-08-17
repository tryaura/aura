const MAX_FINDING_TEXT_CHARACTERS = 500;
const UNICODE_FORMAT_CHARACTER = /\p{Cf}/u;

/** Splits text on user-perceived character boundaries, so truncation never breaks one apart. */
export const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Neutralizes control and Unicode format characters in text Aura did not write itself.
 *
 * Findings and diagnostics quote what was read out of third-party agent configuration, so their
 * text is attacker-influenced in the same way a filename is. An escape sequence reaching the
 * terminal can repaint the report — turning an error line into a passing one — or drive the
 * terminal itself. Unicode format characters can similarly reorder or conceal text, so both kinds
 * are replaced before they are written.
 */
export function safe(value: string): string {
  let result = "";

  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    result +=
      code < 0x20 || (code >= 0x7f && code <= 0x9f) || UNICODE_FORMAT_CHARACTER.test(character)
        ? " "
        : character;
  }

  return result;
}

/** {@link safe}, bounded to what a report line can carry. */
export function safeFindingText(value: string): string {
  // The UTF-16 length bounds the grapheme count, so most values skip segmentation entirely.
  if (value.length <= MAX_FINDING_TEXT_CHARACTERS) {
    return safe(value);
  }

  let kept = "";
  let count = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
    if (count >= MAX_FINDING_TEXT_CHARACTERS) {
      return safe(`${kept}…`);
    }
    kept += segment;
    count += 1;
  }
  return safe(kept);
}

/** {@link safe}, preserving the line structure of a multi-line value. */
export function safeMultiline(value: string): string {
  return value
    .split("\n")
    .map((line) => safe(line))
    .join("\n");
}
