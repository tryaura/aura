import { join } from "node:path";

/**
 * Workspace-relative protocol path of the team preset.
 *
 * A team preset is shared through the repository — unlike the per-user manifest under
 * `~/agents` — so it lives beside the code it governs and travels with checkouts and branches.
 */
export const AURA_TEAM_PRESET_PATH = ".aura/preset.json";

/** Resolves the team-preset protocol path against the directory Aura was invoked from. */
export function resolveTeamPresetPath(cwd: string): string {
  return join(cwd, ".aura", "preset.json");
}
