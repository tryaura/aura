import type { AuraConfigurationLayer } from "./configuration.js";

/** A frozen, data-only runtime preset. It contains no executable hooks or credential values. */
export interface AuraTeamPreset extends AuraConfigurationLayer {
  /** Human-readable preset name. Older repository presets may omit it. */
  readonly name?: string | undefined;
  /** The only team-preset schema this release reads. */
  readonly schemaVersion: 1;
}
