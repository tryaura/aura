import { NO_COLOR_ROW, renderHelpScreen, type HelpRow, type HelpSection } from "./help-layout.js";
import type { CliBranding, CliCommandDefinition, CliCommandFlag } from "./types.js";

/**
 * Help rendering for distribution-registered commands.
 *
 * Rendered from the same `CliCommandDefinition` the parser is built from, so the help surface can
 * never drift from what actually parses. Layout follows the contract in `docs/cli-ux.md`: the same
 * bones as the built-in screens, with "Advanced" carrying only `--no-color` because a distribution
 * command takes `--home` or `--path` only if it declares them itself.
 */

/** One root-screen or unknown-command-screen row per distribution command, in declaration order. */
export function distroCommandRows(
  bin: string,
  commands: readonly CliCommandDefinition[],
): readonly HelpRow[] {
  return commands.map((command) => ({ term: `${bin} ${command.word}`, text: command.summary }));
}

/** The `-h`/`--help` screen for one distribution command. */
export function renderDistroCommandHelp(
  branding: CliBranding,
  definition: CliCommandDefinition,
): string {
  const bin = branding.command;
  const examples = definition.examples ?? [{ args: definition.word, text: definition.summary }];
  const sections: HelpSection[] = [
    {
      rows: examples.map((example) => ({ term: `${bin} ${example.args}`, text: example.text })),
      title: "Everyday use",
    },
  ];
  const flags = definition.flags ?? [];
  if (flags.length > 0) {
    sections.push({ rows: flags.map(flagRow), title: "Options" });
  }
  sections.push({ rows: [NO_COLOR_ROW], title: "Advanced" });
  return renderHelpScreen(
    `${bin} ${definition.word} — ${definition.summary}`,
    sections,
    definition.helpFooters ?? [],
  );
}

function flagRow(flag: CliCommandFlag): HelpRow {
  const term =
    flag.kind === "boolean" || flag.placeholder === undefined
      ? flag.flag
      : `${flag.flag} ${flag.placeholder}`;
  return { term, text: flag.description };
}
