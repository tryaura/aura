/**
 * `--detail` widens what a *scan* reports about a misbehaving plugin and `--fix` rewrites what one
 * found, and `--explain` never scans, so neither has anything to act on. `--json` is supported: an
 * explanation is exactly the kind of thing another tool wants to read.
 */
export function explainOptionRejection(options: {
  readonly detail: boolean;
  readonly explaining: boolean;
  readonly fix: boolean;
  readonly interactive: boolean;
  readonly online: boolean;
  readonly only: boolean;
}): string | undefined {
  if (!options.explaining) {
    return undefined;
  }
  const incompatible = firstExplainConflict(options);
  return incompatible === undefined
    ? undefined
    : `--explain cannot be combined with ${incompatible}`;
}

function firstExplainConflict(options: {
  readonly detail: boolean;
  readonly fix: boolean;
  readonly interactive: boolean;
  readonly online: boolean;
  readonly only: boolean;
}): string | undefined {
  if (options.detail) {
    return "--detail";
  }
  if (options.fix) {
    return "--fix";
  }
  if (options.interactive) {
    return "--interactive";
  }
  if (options.online) {
    return "--online";
  }
  return options.only ? "--only" : undefined;
}

export function fixOptionRejection(options: {
  readonly dryRun: boolean;
  readonly fix: boolean;
  readonly interactive: boolean;
  readonly yes: boolean;
}): string | undefined {
  return missingFixRejection(options) ?? contradictoryFixRejection(options);
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
  return options.interactive && options.yes
    ? "--interactive and --yes contradict each other: the deprecated alias asks for guided choices, while --yes forbids questions."
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
