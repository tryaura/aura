import type { DirectorySkillSource, SkillSourceId } from "./content.js";

/**
 * The minimal team preset a repository can carry until the full layered format lands.
 *
 * Pure data shared through version control: it may point Aura at private skill directories and
 * restrict which sources members install from, but it never carries a credential — a private
 * directory names the environment variable holding its token, nothing more.
 */
export interface AuraTeamPreset {
  /**
   * Skill sources members may install from.
   *
   * Absent means every registered source is permitted. Present, it is exhaustive: a source not on
   * the list is neither shown in pickers nor installable, and a manifest entry from one blocks
   * setup until it is cleared.
   */
  readonly allowedSkillSources?: readonly SkillSourceId[] | undefined;
  /** The only team-preset schema this release reads. */
  readonly schemaVersion: 1;
  /**
   * Directories defined by the team rather than a plugin.
   *
   * Tokens stay in the named environment variables. A client must obtain explicit user approval
   * before connecting to a private directory or reading its token variable.
   */
  readonly skillDirectories?: readonly DirectorySkillSource[] | undefined;
}
