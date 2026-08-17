/** Text attributes a renderer can apply without knowing whether the terminal supports them. */
export interface Style {
  readonly bold: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly green: (text: string) => string;
  readonly red: (text: string) => string;
  readonly yellow: (text: string) => string;
}

/**
 * Builds the styling functions for a terminal's color depth.
 *
 * With `colorDepth` 0 every function returns plain text, so captured streams stay byte-stable with
 * no escape sequences at all. Styling is applied to already-sanitized text: `safe()` strips ESC
 * from untrusted input, so the only escape sequences on the wire are the ones added here. Every
 * function is width-neutral — glyphs, not styling, carry state on a monochrome terminal
 * (docs/cli-ux.md), so no variant may add visible columns the layout arithmetic does not count.
 */
export function createStyle(colorDepth: number): Style {
  if (colorDepth <= 0) {
    return {
      bold: (text) => text,
      dim: (text) => text,
      green: (text) => text,
      red: (text) => text,
      yellow: (text) => text,
    };
  }
  return {
    bold: (text) => `\u001b[1m${text}\u001b[22m`,
    dim: (text) => `\u001b[2m${text}\u001b[22m`,
    green: (text) => `\u001b[32m${text}\u001b[39m`,
    red: (text) => `\u001b[31m${text}\u001b[39m`,
    yellow: (text) => `\u001b[33m${text}\u001b[39m`,
  };
}
