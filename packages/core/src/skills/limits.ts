/**
 * The largest directory index Aura will read, in bytes.
 *
 * Same number as the other catalog caps in `workspace/reader-limits.ts`: an index is a metadata
 * document, and the picker reads it while the user waits.
 */
export const MAX_DIRECTORY_INDEX_BYTES = 256_000;

/** The most listings one directory index may advertise; entries beyond the cap are dropped. */
export const MAX_DIRECTORY_INDEX_ENTRIES = 1_000;

/** The largest single skill response Aura will read, in bytes. */
export const MAX_SKILL_RESPONSE_BYTES = 5_000_000;

/** The largest single file inside a fetched skill, in bytes. */
export const MAX_SKILL_FILE_BYTES = 1_000_000;

/** The most files one fetched skill may carry. */
export const MAX_SKILL_FILES = 200;
