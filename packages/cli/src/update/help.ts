import { NO_COLOR_ROW, renderHelpScreen } from "../help-layout.js";
import type { CliBranding } from "../types.js";

export function renderUpdateHelp(branding: CliBranding): string {
  const bin = branding.command;
  return renderHelpScreen(
    `${bin} update — Check for and install an update`,
    [
      {
        rows: [
          {
            term: `${bin} update`,
            text: "Bypass the update cache, install an available update, and exit",
          },
        ],
        title: "Everyday use",
      },
      {
        rows: [NO_COLOR_ROW],
        title: "Advanced",
      },
    ],
    [
      "Available only in a standalone installation",
      "Exit codes: 0 current or installed · 1 another update is in progress · 2 unavailable in this environment · 3 operational failure",
    ],
  );
}
