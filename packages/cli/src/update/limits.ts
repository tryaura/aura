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

/**
 * How far ahead of now a signed manifest's `expiresAt` may sit.
 *
 * A signature proves who wrote a manifest, never that it is the newest one they wrote. Without a
 * bound, anything that can serve a stale-but-valid copy — a compromised edge, a caching proxy, a
 * mirror left behind — pins a fleet to a release forever, and the updater reports nothing because
 * "no newer release" is the quiet path. The window is what turns that freeze into an expiry.
 *
 * Capped rather than merely required, because a publisher who dates a manifest a decade out has
 * satisfied the field and rebuilt the same problem.
 */
export const MAX_MANIFEST_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1_000;

/** Redirect hops followed while downloading an archive. */
export const MAX_REDIRECTS = 5;

/**
 * Milliseconds the whole startup update may spend before the user's command starts.
 *
 * The one number that bounds the wait, because it is the only one the user experiences. Every step
 * below has its own ceiling, but a per-step bound is not an aggregate: metadata, a probe of the
 * installed binary, the transfer, and a probe of the staged one each finishing just inside their
 * own limit is a command that has not started yet. The download is given whatever is left of this,
 * so a slow transfer is abandoned rather than allowed to consume the sum of the other steps too.
 */
export const STARTUP_UPDATE_BUDGET_MS = 240_000;

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
