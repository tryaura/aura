import type { AuraConfigurationLayer } from "./configuration.js";
import type { AuraTeamPresetProvides } from "./repo-content.js";

/** A frozen, data-only runtime preset. It contains no executable hooks or credential values. */
export interface AuraTeamPreset extends AuraConfigurationLayer {
  /** Human-readable preset name. Older repository presets may omit it. */
  readonly name?: string | undefined;
  /**
   * Content the repository defines itself. Valid only in `.aura/preset.json`: a preset that
   * arrives by download selects content, it does not author it.
   */
  readonly provides?: AuraTeamPresetProvides | undefined;
  /** The only team-preset schema this release reads. */
  readonly schemaVersion: 1;
}
