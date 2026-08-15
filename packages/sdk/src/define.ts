import type { Adapter } from "./adapter.js";
import type { Check } from "./check.js";
import type { AuraPlugin } from "./plugin.js";

export function defineAdapter<const TAdapter extends Adapter>(adapter: TAdapter): TAdapter {
  return adapter;
}

export function defineCheck<const TCheck extends Check>(check: TCheck): TCheck {
  return check;
}

export function definePlugin<const TPlugin extends AuraPlugin>(plugin: TPlugin): TPlugin {
  return plugin;
}
