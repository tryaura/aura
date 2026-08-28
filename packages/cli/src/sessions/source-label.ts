import type { SessionSource } from "@tryaura/core";

/** Codex leads for continuity with reports produced before Claude Code support existed. */
const DISPLAY_ORDER: readonly SessionSource[] = ["codex", "claude-code"];

const SOURCE_NAMES: Readonly<Record<SessionSource, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/** The human name of what the analysis scanned for, e.g. `Codex + Claude Code`. */
export function sourcesLabel(sources: readonly SessionSource[]): string {
  return DISPLAY_ORDER.filter((source) => sources.includes(source))
    .map((source) => SOURCE_NAMES[source])
    .join(" + ");
}
