import type { Adapter, Check } from "@tryaura/aura-sdk";
import { canonicalAppId } from "@tryaura/core";

import { safe } from "./safe-text.js";

export interface CheckSelection {
  readonly adapters: readonly Adapter[];
  readonly checks: readonly Check[];
}

export type CheckSelectionResult =
  | { readonly selection: CheckSelection; readonly status: "selected" }
  | { readonly message: string; readonly status: "unknown" };

/** Resolves repeatable check/category and app selectors into two intersecting filters. */
export function selectChecks(
  checks: readonly Check[],
  adapters: readonly Adapter[],
  selectors: readonly string[],
): CheckSelectionResult {
  if (selectors.length === 0) {
    return { selection: { adapters, checks }, status: "selected" };
  }

  const realAdapters = adapters.filter((adapter) => adapter.synthetic !== true);
  const selectedCheckIds = new Set<string>();
  const selectedAppIds = new Set<string>();
  let hasCheckSelector = false;
  let hasAppSelector = false;

  for (const selector of selectors) {
    const lower = selector.toLowerCase();
    const exactCheck = checks.find((check) => check.id.toLowerCase() === lower);
    if (exactCheck !== undefined) {
      selectedCheckIds.add(exactCheck.id);
      hasCheckSelector = true;
      continue;
    }

    const categoryChecks = checks.filter(
      (check) => checkCategory(check.id).toLowerCase() === lower,
    );
    if (categoryChecks.length > 0) {
      for (const check of categoryChecks) {
        selectedCheckIds.add(check.id);
      }
      hasCheckSelector = true;
      continue;
    }

    const appId = canonicalAppId(selector);
    const adapter = realAdapters.find((candidate) => candidate.id.toLowerCase() === appId);
    if (adapter !== undefined) {
      selectedAppIds.add(adapter.id);
      hasAppSelector = true;
      continue;
    }

    return { message: unknownSelector(selector, checks, realAdapters), status: "unknown" };
  }

  return {
    selection: {
      // Synthetic adapters survive every app selector. They model no application a user could name
      // — the legacy instruction inventory is one — but checks read the model they contribute to.
      // Dropping them would leave those checks with nothing to look at and report them as passed,
      // which is the one failure mode a setup doctor cannot have.
      adapters: hasAppSelector
        ? adapters.filter((adapter) => adapter.synthetic === true || selectedAppIds.has(adapter.id))
        : adapters,
      checks: hasCheckSelector ? checks.filter((check) => selectedCheckIds.has(check.id)) : checks,
    },
    status: "selected",
  };
}

/** Category prefix from the local part of a namespaced or bare check ID. */
export function checkCategory(checkId: string): string {
  const localId = checkId.slice(checkId.lastIndexOf("/") + 1);
  const separator = localId.indexOf("-");
  return (separator === -1 ? localId : localId.slice(0, separator)).toUpperCase();
}

function unknownSelector(
  selector: string,
  checks: readonly Check[],
  adapters: readonly Adapter[],
): string {
  const categories = [...new Set(checks.map((check) => checkCategory(check.id)))].sort();
  const checkIds = checks.map((check) => check.id).sort();
  const appIds = adapters.map((adapter) => adapter.id).sort();
  return [
    `unknown --only selector: ${safe(selector)}`,
    `Valid categories: ${safe(categories.join(", ")) || "(none)"}`,
    `Valid check IDs: ${safe(checkIds.join(", ")) || "(none)"}`,
    `Valid app IDs: ${safe(appIds.join(", ")) || "(none)"}`,
  ].join("\n");
}
