import { join } from "node:path";

import type { FileMode } from "@tryaura/aura-sdk";

/** Home-relative protocol path shared by every Aura distribution. */
export const AURA_MANIFEST_PATH = "~/agents/aura.json";

/**
 * The mode the manifest is held at, whatever mode it already has on disk.
 *
 * Desired state may come to reference private sources, so this is the one file whose permissions
 * core will tighten under a user rather than preserve. The fix-plan kernel applies it by path, so
 * no plan can ask for the same treatment somewhere else.
 */
export const AURA_MANIFEST_FILE_MODE: FileMode = 0o600;

/** The only desired-state manifest schema this core release can write. */
export const AURA_MANIFEST_SCHEMA_VERSION = 1;

/** Resolves the manifest protocol path against one captured home directory. */
export function resolveAuraManifestPath(homeDir: string): string {
  return join(homeDir, "agents", "aura.json");
}
