/**
 * The largest directory index Aura will read, in bytes.
 *
 * Same number as the other catalog caps in `workspace/reader-limits.ts`: an index is a metadata
 * document, and the picker reads it while the user waits.
 */
export const MAX_DIRECTORY_INDEX_BYTES = 256_000;

/** The most listings one directory index may advertise; entries beyond the cap are dropped. */
export const MAX_DIRECTORY_INDEX_ENTRIES = 1_000;

/** The most remote directories one workspace team preset may declare. */
export const MAX_TEAM_PRESET_DIRECTORIES = 32;

/** The most source ids one workspace team preset allowlist may carry. */
export const MAX_TEAM_PRESET_ALLOWED_SOURCES = 256;

/** The most skill-content requests Aura runs concurrently for one directory. */
export const MAX_CONCURRENT_SKILL_REQUESTS = 8;

/**
 * The most existence probes Aura runs concurrently while listing a provider directory.
 *
 * Higher than the content limit because a probe is one small static-host GET whose body is
 * discarded, and because the whole sweep sits between the user and the picker: a catalog of a
 * couple hundred entries has to clear in about a second, not five.
 */
export const MAX_CONCURRENT_SKILL_PROBES = 24;

/** The largest single skill response Aura will read, in bytes. */
export const MAX_SKILL_RESPONSE_BYTES = 5_000_000;

/** The largest single file inside a fetched skill, in bytes. */
export const MAX_SKILL_FILE_BYTES = 1_000_000;

/** The most files one fetched skill may carry. */
export const MAX_SKILL_FILES = 200;
