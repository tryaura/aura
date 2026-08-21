import type { Adapter } from "@tryaura/aura-sdk";

import type { RegistryState } from "./plugin-validation.js";
import { sharedLinkViolations } from "./workspace/shared-links.js";

/**
 * Validates an adapter's shared-instruction link declaration.
 *
 * Two rules, because the contract removed one field and constrained the other. A plugin built
 * against the previous contract still carries `projectSharedLink`; `apiVersion` already refuses
 * that plugin, and naming the property is what tells its author which one to delete.
 */
export function collectSharedLinkDeclarationViolations(
  state: RegistryState,
  adapter: Adapter,
  pluginLabel: string,
): void {
  if ("projectSharedLink" in adapter) {
    state.violations.push(
      `${pluginLabel} adapter "${adapter.id}" declares removed projectSharedLink; ` +
        "Aura manages only global shared-instruction links. Remove this property.",
    );
  }
  if (adapter.sharedLink === undefined) {
    return;
  }
  for (const violation of sharedLinkViolations(adapter.sharedLink)) {
    state.violations.push(
      `${pluginLabel} adapter "${adapter.id}" declares invalid sharedLink: ${violation}.`,
    );
  }
}
