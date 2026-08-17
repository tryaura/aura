import { safe } from "./safe-text.js";
import type { CliBranding } from "./types.js";

/**
 * Action-first help screens.
 *
 * Every screen leads with what to run next rather than an inventory of flags: commands and flags
 * are grouped by the task they serve, ordered by how often that task comes up, and plumbing that
 * exists for tests and CI sits last under "Advanced". The full UX contract lives in
 * `docs/cli-ux.md`; these renderers are its implementation.
 */

interface HelpRow {
  readonly term: string;
  readonly text: string;
}

interface HelpSection {
  readonly rows: readonly HelpRow[];
  readonly title: string;
}

export function renderRootHelp(branding: CliBranding): string {
  const bin = branding.command;
  return renderHelpScreen(
    headline(branding),
    [
      {
        rows: [{ term: `${bin} setup`, text: "Set up this machine interactively and converge it" }],
        title: "Get started",
      },
      {
        rows: [
          { term: `${bin} check`, text: "Inspect the current AI agent setup" },
          { term: `${bin} check --fix`, text: "Preview fixes and apply them after confirming" },
          { term: `${bin} undo`, text: "Restore the most recent Aura backup" },
        ],
        title: "Everyday use",
      },
      {
        rows: [
          { term: `${bin} <command> --help`, text: "Full flag reference for a command" },
          // The version command only registers when branding carries a version (run.ts), so the
          // row appears exactly when the flag exists.
          ...(branding.version === undefined
            ? []
            : [{ term: `${bin} --version`, text: "Print the version and exit" }]),
        ],
        title: "Help",
      },
    ],
    branding.docsUrl === undefined ? [] : [`Docs: ${branding.docsUrl}`],
  );
}

export function renderCheckHelp(branding: CliBranding): string {
  const bin = branding.command;
  return renderHelpScreen(
    `${bin} check — Inspect the current AI agent setup`,
    [
      {
        rows: [
          { term: `${bin} check`, text: "Run all checks" },
          { term: `${bin} check --fix`, text: "Preview fixes and apply them after confirming" },
          {
            term: `${bin} check --fix --dry-run`,
            text: "Show what fixing would change, write nothing",
          },
        ],
        title: "Everyday use",
      },
      {
        rows: [
          {
            term: "--only <filter>",
            text: "Run one check ID, category, or application; repeatable",
          },
          { term: "--explain <id>", text: "Explain one check without scanning" },
          { term: "--detail", text: "Include the failing plugin's own error text" },
        ],
        title: "Narrow it down",
      },
      {
        rows: [
          { term: "--interactive", text: "With --fix, walk through guided remediation choices" },
          { term: "--yes", text: "Apply without asking; required when stdin is not a terminal" },
        ],
        title: "Fixing behavior",
      },
      {
        rows: [
          { term: "--json", text: "Emit JSON instead of human output" },
          {
            term: "--json-version <n>",
            text: "Select the machine-readable contract version (supported: 1)",
          },
        ],
        title: "Scripting",
      },
      { rows: advancedRows(), title: "Advanced" },
    ],
    [
      "Exit codes: 0 clean · 1 warnings · 2 errors or usage/state conflicts · 3 operational failures",
    ],
  );
}

export function renderSetupHelp(branding: CliBranding, addKinds: readonly string[]): string {
  const bin = branding.command;
  const supportedAddKinds = addKinds.length === 0 ? "none" : addKinds.join(", ");
  return renderHelpScreen(
    `${bin} setup — Set up this machine interactively and converge it`,
    [
      {
        rows: [
          { term: `${bin} setup`, text: "Run the setup wizard" },
          { term: `${bin} setup --dry-run`, text: "Stop after the plan summary, write nothing" },
        ],
        title: "Everyday use",
      },
      {
        rows: [
          {
            term: "--yes",
            text: "Accept every proposed default; required when stdin is not a terminal",
          },
          { term: "--detail", text: "Include the full diff of every planned change" },
          {
            term: "--add <kind>",
            text: `Run one setup addition (supported: ${supportedAddKinds})`,
          },
        ],
        title: "Options",
      },
      { rows: advancedRows(), title: "Advanced" },
    ],
    [`After setup, run '${bin} check' to verify the machine converged`],
  );
}

export function renderUndoHelp(branding: CliBranding): string {
  const bin = branding.command;
  return renderHelpScreen(
    `${bin} undo — Restore files from an Aura backup`,
    [
      {
        rows: [
          { term: `${bin} undo`, text: "Restore the most recent backup" },
          { term: `${bin} undo --list`, text: "List every available backup" },
          { term: `${bin} undo <backup-id>`, text: "Restore one backup by name" },
          {
            term: `${bin} undo --dry-run`,
            text: "Show which backup would be restored, write nothing",
          },
        ],
        title: "Everyday use",
      },
      {
        rows: [
          { term: "--yes", text: "Restore without asking; required when stdin is not a terminal" },
          { term: "--detail", text: "Include the underlying error when restoration fails" },
        ],
        title: "Options",
      },
      { rows: advancedRows(), title: "Advanced" },
    ],
    [
      "Exit codes: 0 restored or nothing to undo · 1 aborted or declined at the prompt · 2 conflicts · 3 operational failures",
    ],
  );
}

/** The unknown-command screen redirects to what exists instead of dumping a parser trace. */
export function renderUnknownCommand(branding: CliBranding, input: string): string {
  const bin = branding.command;
  // The input is echoed argv, which a wrapper script can fill with untrusted text; neutralize it
  // like any other text Aura did not write itself.
  return renderHelpScreen(
    `${bin}: unknown command '${safe(input)}'`,
    [
      {
        rows: [
          { term: `${bin} setup`, text: "Set up this machine interactively and converge it" },
          { term: `${bin} check`, text: "Inspect the current AI agent setup" },
          { term: `${bin} undo`, text: "Restore the most recent Aura backup" },
        ],
        title: "Commands",
      },
    ],
    [`Run '${bin} --help' for more`],
  );
}

/** Test and CI plumbing, present on every command and interesting to almost nobody. */
function advancedRows(): readonly HelpRow[] {
  return [
    { term: "--home <dir>", text: "Override the home directory" },
    { term: "--path <dir>", text: "Override the executable search path" },
  ];
}

function headline(branding: CliBranding): string {
  const name =
    branding.version === undefined
      ? branding.displayName
      : `${branding.displayName} ${branding.version}`;
  return branding.description === undefined ? name : `${name} — ${branding.description}`;
}

/** Terms align to one shared column so the eye scans a single list, not per-section islands. */
function renderHelpScreen(
  header: string,
  sections: readonly HelpSection[],
  footers: readonly string[],
): string {
  const width = Math.max(
    ...sections.flatMap((section) => section.rows.map((row) => row.term.length)),
  );
  const lines = [header];
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
