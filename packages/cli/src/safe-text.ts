const MAX_FINDING_TEXT_CHARACTERS = 500;
const UNICODE_FORMAT_CHARACTER = /\p{Cf}/u;

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
  const truncated =
    value.length > MAX_FINDING_TEXT_CHARACTERS
      ? `${value.slice(0, MAX_FINDING_TEXT_CHARACTERS)}…`
      : value;

  return safe(truncated);
}

/** {@link safe}, preserving the line structure of a multi-line value. */
export function safeMultiline(value: string): string {
  return value
    .split("\n")
    .map((line) => safe(line))
    .join("\n");
}
