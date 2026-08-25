/**
 * Shared layout primitives behind every help screen.
 *
 * The renderers in help.ts and help-distro-command.ts implement the contract in `docs/cli-ux.md`;
 * this module carries the pieces they share so distribution-registered commands render with the
 * exact same bones as the built-in screens.
 */

export interface HelpRow {
  readonly term: string;
  readonly text: string;
}

export interface HelpSection {
  readonly rows: readonly HelpRow[];
  readonly title: string;
}

/** The one flag every screen shares, because it is consumed before any command parses. */
export const NO_COLOR_ROW: HelpRow = { term: "--no-color", text: "Disable terminal colors" };

/** Test and CI plumbing, present on every scanning command and interesting to almost nobody. */
export function advancedRows(): readonly HelpRow[] {
  return [
    { term: "--home <dir>", text: "Override the home directory" },
    NO_COLOR_ROW,
    { term: "--path <dir>", text: "Override the executable search path" },
  ];
}

/** Terms align to one shared column so the eye scans a single list, not per-section islands. */
export function renderHelpScreen(
  header: string,
  sections: readonly HelpSection[],
  footers: readonly string[],
  intro: readonly string[] = [],
): string {
  const width = Math.max(
    ...sections.flatMap((section) => section.rows.map((row) => row.term.length)),
  );
  const lines = [header];
  if (intro.length > 0) {
    lines.push("", ...intro.map((line) => `  ${line}`));
  }
  for (const section of sections) {
    lines.push("", `  ${section.title}`);
    for (const row of section.rows) {
      lines.push(`    ${row.term.padEnd(width)}    ${row.text}`);
    }
  }
  for (const footer of footers) {
    lines.push("", `  ${footer}`);
  }
  return `${lines.join("\n")}\n`;
}
