import type { Adapter } from "./adapter.js";
import type { Check } from "./check.js";
import type { AuraPlugin } from "./plugin.js";

/**
 * Type-checks an {@link Adapter} at the point it is written.
 *
 * Returns the value unchanged. Without it, a mistake in an adapter literal surfaces wherever the
 * adapter is registered rather than on the property that is wrong.
 */
export function defineAdapter<const TAdapter extends Adapter>(adapter: TAdapter): TAdapter {
  return adapter;
}

/** Type-checks a {@link Check} at the point it is written. See {@link defineAdapter}. */
export function defineCheck<const TCheck extends Check>(check: TCheck): TCheck {
  return check;
}

/**
 * Type-checks an {@link AuraPlugin} at the point it is written.
 *
 * Export the result as the module's default export so Aura core can load it.
 */
export function definePlugin<const TPlugin extends AuraPlugin>(plugin: TPlugin): TPlugin {
  return plugin;
}
