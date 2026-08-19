import type { AuraPlugin, Check } from "@tryaura/aura-sdk";

import type { RegistryState } from "./plugin-validation.js";

/** Validates concise-output groups without claiming them as unique contributions. */
export function collectFindingGroupViolations(
  state: RegistryState,
  checks: readonly Check[] | undefined,
  plugin: AuraPlugin,
): void {
  const groups = new Map<string, Check["findingGroup"]>();
  const namespace = `${plugin.id}/`;

  for (const check of checks ?? []) {
    const group = check.findingGroup;
    if (group === undefined) {
      continue;
    }
    if (!group.id.startsWith(namespace) || group.id.length === namespace.length) {
      state.violations.push(
        `${pluginLabel(plugin)} check "${check.id}" declares finding-group ID "${group.id}"; ` +
          `expected the "${namespace}<id>" namespace.`,
      );
    }
    if (group.title.trim().length === 0 || group.description.trim().length === 0) {
      state.violations.push(
        `${pluginLabel(plugin)} check "${check.id}" declares finding group "${group.id}" ` +
          "with an empty title or description.",
      );
    }
    const previous = groups.get(group.id);
    if (
      previous !== undefined &&
      (previous.title !== group.title || previous.description !== group.description)
    ) {
      state.violations.push(
        `${pluginLabel(plugin)} finding group "${group.id}" uses inconsistent titles or descriptions.`,
      );
    } else {
      groups.set(group.id, group);
    }
  }
}

function pluginLabel(plugin: AuraPlugin): string {
  return `Plugin "${plugin.name}" (${plugin.id})`;
}
