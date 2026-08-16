/** The largest unbounded file Aura reads, in bytes. */
export const MAX_FILE_BYTES = 10_000_000;

/**
 * The largest bundled snippet Aura will resolve, in bytes.
 *
 * A snippet is a Markdown fragment pasted into an instruction file, so it is bounded by what a
 * human would tolerate reading, not by what the filesystem will hand over. The scan reads every
 * registered snippet on every run; without this, one oversized file in one plugin makes every
 * command pay for it.
 */
export const MAX_SNIPPET_BYTES = 256_000;

/** The most directory entries Aura lists during one read. */
export const MAX_DIRECTORY_ENTRIES = 10_000;
