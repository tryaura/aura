import { resolve } from "node:path";

import type { InstructionSource } from "./instructions.js";
import { managedAppIdList } from "./managed-apps.js";
import type { InstructionScopeSelection, SetupStepContext } from "./types.js";

/**
 * Entry paths consolidation has to take, whatever the wizard's selection says.
 *
 * A symbolic link stands in for the whole file at its entry, so an app declaring one is wirable
 * only once that entry is merged here and archived. The wizard does not offer an entry already
 * pointing at the target, so leaving this to the selection strands the app on every run.
 */
function mandatoryEntryPaths(context: SetupStepContext): ReadonlySet<string> {
  const managedIds = new Set(managedAppIdList(context));
  const paths = new Set<string>();
  for (const app of context.model.apps) {
    if (app.synthetic === true || !managedIds.has(app.adapterId)) {
      continue;
    }
    const link = app.sharedLink;
    if (link?.kind === "symlink") {
      paths.add(resolve(link.entryPath));
    }
  }
  return paths;
}

/**
 * The inventory entries this scope must take, in the order the inventory already sorted them.
 *
 * Resolved once for either path: `consolidate` and `keep` merge them first, `template` only
 * archives them.
 */
export function requiredEntries(
  context: SetupStepContext,
  selection: InstructionScopeSelection,
  inventory: readonly InstructionSource[],
): readonly InstructionSource[] {
  const required = mandatoryEntryPaths(context);
  return inventory.filter(
    (source) => source.scope === selection.scope && required.has(resolve(source.path)),
  );
}

/** Folds the required entries into the selection, so the merge and the archive both see them. */
export function withMandatorySources(
  selection: InstructionScopeSelection,
  required: readonly InstructionSource[],
): InstructionScopeSelection {
  const selected = new Set(selection.selectedSources.map((path) => resolve(path)));
  const missing = required
    .filter((source) => !selected.has(resolve(source.path)))
    .map((source) => source.path);
  return missing.length === 0
    ? selection
    : { ...selection, selectedSources: [...selection.selectedSources, ...missing] };
}
