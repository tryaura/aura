import { detectLineEnding, splitSourceLines } from "@tryaura/aura-sdk";

const BEGIN = "# aura:begin ENV-003";
const END = "# aura:end ENV-003";

const MANAGED_LINES: readonly string[] = [
  BEGIN,
  "# Managed by Aura. Personal agent state stays local; team configuration stays shareable.",
  "/.claude/settings.local.json",
  "!/AGENTS.md",
  "!/CLAUDE.md",
  "!/.mcp.json",
  END,
];

/** Replaces Aura's gitignore block and moves it last so its negations take precedence. */
export function reconcileGitignoreBlock(source: string): string | undefined {
  const lines = [...splitSourceLines(source)];
  if (lines.some((line) => isMalformedMarker(line.text))) {
    return undefined;
  }
  const begins = lines.filter((line) => line.text === BEGIN);
  const ends = lines.filter((line) => line.text === END);
  if (begins.length > 1 || ends.length > 1 || begins.length !== ends.length) {
    return undefined;
  }

  let unmanaged = source;
  if (begins.length === 1 && ends.length === 1) {
    const begin = begins[0];
    const end = ends[0];
    if (begin === undefined || end === undefined || end.start < begin.start) {
      return undefined;
    }
    unmanaged = source.slice(0, begin.start) + source.slice(end.end);
  }

  const lineEnding = detectLineEnding(unmanaged);
  const separator = unmanaged.length === 0 || unmanaged.endsWith("\n") ? "" : lineEnding;
  return `${unmanaged}${separator}${MANAGED_LINES.join(lineEnding)}${lineEnding}`;
}

function isMalformedMarker(line: string): boolean {
  const normalized = line.trim();
  return (
    (normalized.startsWith(BEGIN) && normalized !== BEGIN) ||
    (normalized.startsWith(END) && normalized !== END) ||
    ((normalized === BEGIN || normalized === END) && line !== normalized)
  );
}
