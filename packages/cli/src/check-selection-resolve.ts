import type { AuraEffectiveConfig, Check } from "@tryaura/aura-sdk";

import type { AuraCliContext } from "./cli-context.js";
import { selectChecks, type CheckSelection } from "./check-selection.js";

/** Resolves `--only` into checks and adapters, reporting a bad selector on stderr. */
export function resolveCheckSelection(
  context: AuraCliContext,
  only: readonly string[],
): CheckSelection | undefined {
  const result = selectChecks(context.registry.checks, context.registry.adapters, only);
  if (result.status === "selected") {
    return result.selection;
  }
  context.stderr.write(`${context.branding.displayName}: ${result.message}\n`);
  return undefined;
}

/**
 * Finds an `--only` selector naming a check configuration has switched off.
 *
 * Asking for one check by name and getting a clean run because a preset disabled it is the
 * silent-success case worth refusing: the user named the check, so the conflict is the answer.
 */
export function disabledOnlySelector(
  checks: readonly Check[],
  only: readonly string[],
  config: AuraEffectiveConfig,
): string | undefined {
  return only.find((selector) => {
    const check = checks.find(({ id }) => id.toLocaleLowerCase() === selector.toLocaleLowerCase());
    return check !== undefined && config.checks[check.id]?.enabled.value === false;
  });
}
