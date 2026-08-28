// Deep import on purpose: see the note in run.boundary.ts.
import { NO_COLOR_ROW, renderHelpScreen } from "../help-layout.js";
import type { CliBranding } from "../types.js";

export function renderSessionsHelp(branding: CliBranding): string {
  const bin = branding.command;
  return renderHelpScreen(
    `${bin} sessions — Summarize recent coding agent sessions`,
    [
      {
        rows: [
          {
            term: `${bin} sessions`,
            text: "Summarize the last 30 days of Codex and Claude Code sessions",
          },
          { term: `${bin} sessions --days 90`, text: "Widen the look-back window" },
          {
            term: `${bin} sessions --brief`,
            text: "Write a handoff brief a coding agent can act on",
          },
        ],
        title: "Everyday use",
      },
      {
        rows: [
          { term: "--source <app>", text: "Analyze one source only: codex or claude-code" },
          { term: "--verbose", text: "List every directory instead of only the busiest" },
          { term: "--brief[=<path>]", text: "Write an agent handoff brief" },
          { term: "--force", text: "Replace an existing brief target" },
        ],
        title: "Reporting",
      },
      {
        rows: [
          { term: "--json", text: "Emit JSON instead of human output" },
          { term: "--detailed", text: "Add one row per recorded tool call to the JSON document" },
        ],
        title: "Scripting",
      },
      // No `--path`: the command reads transcripts, never executables, so advertising the shared
      // search-path override would advertise a parse error.
      {
        rows: [{ term: "--home <dir>", text: "Override the home directory" }, NO_COLOR_ROW],
        title: "Advanced",
      },
    ],
    [
      "Reads local transcripts only; nothing leaves this machine",
      "Exit codes: 0 report produced · 2 invalid usage · 3 operational failures",
    ],
  );
}
