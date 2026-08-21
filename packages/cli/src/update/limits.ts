/**
 * Every bound the updater enforces, in one place.
 *
 * A limit that lives next to its single use gets relaxed by whoever is debugging that use. These
 * are the numbers a reviewer needs to see together to know an update cannot exhaust the disk, the
 * heap, the network, or the user's patience.
 */

/** Bytes accepted for one release archive, streamed and counted rather than buffered. */
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

/**
 * Bytes accepted from an archive's extracted entries, so a compression bomb cannot fill a disk.
 *
 * Larger than the archive bound because the archive is compressed, and small enough that the worst
 * case is a temporary file the transaction removes rather than a full disk.
 */
export const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;

/** Bytes accepted for one release-metadata document. */
export const MAX_METADATA_BYTES = 512 * 1024;

/** Bytes accepted for one cached metadata entry. */
export const MAX_CACHE_BYTES = 64 * 1024;

/** Redirect hops followed while downloading an archive. */
export const MAX_REDIRECTS = 5;

/** Milliseconds one archive download may take, start to finish. */
export const DOWNLOAD_TIMEOUT_MS = 300_000;

/** Milliseconds one metadata request may take. */
export const METADATA_TIMEOUT_MS = 10_000;

/** Milliseconds a version probe of an executable may take. */
export const VERSION_PROBE_TIMEOUT_MS = 30_000;

/** How long a successful "already current" check stays fresh. */
export const CHECK_FRESH_MS = 24 * 60 * 60 * 1_000;

/** How long a failed check waits before the next one, silently. */
export const CHECK_RETRY_MS = 60 * 60 * 1_000;

/** First backoff step after an installation failure, doubled per attempt. */
export const INSTALL_BACKOFF_BASE_MS = 15 * 60 * 1_000;

/** Ceiling the installation backoff doubles up to. */
export const INSTALL_BACKOFF_MAX_MS = 24 * 60 * 60 * 1_000;

/** How old a lock must be before its owner is treated as gone. */
export const LOCK_STALE_MS = 10 * 60 * 1_000;
