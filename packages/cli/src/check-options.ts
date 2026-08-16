export function fixOptionRejection(options: {
  readonly dryRun: boolean;
  readonly fix: boolean;
  readonly interactive: boolean;
  readonly stdinTerminal: boolean;
  readonly stdoutTerminal: boolean;
  readonly yes: boolean;
}): string | undefined {
  return (
    missingFixRejection(options) ??
    contradictoryFixRejection(options) ??
    interactiveTerminalRejection(options)
  );
}

function missingFixRejection(options: {
  readonly dryRun: boolean;
  readonly fix: boolean;
  readonly interactive: boolean;
  readonly yes: boolean;
}): string | undefined {
  const flag = firstFixDependentFlag(options.dryRun, options.interactive, options.yes);
  return !options.fix && flag !== undefined
    ? `${flag} only means something with --fix. Add --fix, or drop it.`
    : undefined;
}

function contradictoryFixRejection(options: {
  readonly dryRun: boolean;
  readonly interactive: boolean;
  readonly yes: boolean;
}): string | undefined {
  if (options.dryRun && options.yes) {
    return "--dry-run and --yes contradict each other: one stops at the preview, the other applies without asking.";
  }
  if (options.interactive && options.yes) {
    return "--interactive and --yes contradict each other: one asks for guided choices, the other forbids questions.";
  }
  return undefined;
}

function interactiveTerminalRejection(options: {
  readonly interactive: boolean;
  readonly stdinTerminal: boolean;
  readonly stdoutTerminal: boolean;
}): string | undefined {
  return options.interactive && (!options.stdinTerminal || !options.stdoutTerminal)
    ? "stdin and prompt output must both be terminals for --interactive."
    : undefined;
}

function firstFixDependentFlag(
  dryRun: boolean,
  interactive: boolean,
  yes: boolean,
): string | undefined {
  if (dryRun) {
    return "--dry-run";
  }
  if (interactive) {
    return "--interactive";
  }
  return yes ? "--yes" : undefined;
}
