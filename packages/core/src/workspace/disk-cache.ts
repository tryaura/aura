import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Environment } from "@tryaura/aura-sdk";

import { createFileReader } from "./reader.js";

/**
 * Shared primitives for the on-disk caches below `~/agents/.cache`.
 *
 * A cache here is an optimization and nothing more: every reader treats a malformed, oversized,
 * or unreadable entry as a miss, and a failed write leaves the world exactly as it was. Entries
 * are private to the user (`0700` directories, `0600` files) and land atomically via a temporary
 * file and rename, so a concurrent run never observes half an entry.
 */

/**
 * The caches' own reader, built once rather than per lookup.
 *
 * Deliberately not a caller-injected reader: entries are written here with `node:fs` and are
 * machine state rather than workspace content, so reading them through a substituted reader would
 * let a run see a cache it cannot write and write one it cannot see.
 */
const CACHE_READER = createFileReader();

/** Where one cache entry lives: its namespace directory and the hashed key path inside it. */
export interface CacheLocation {
  readonly directory: string;
  readonly path: string;
}

/** Resolves one entry's location below `~/agents/.cache/<namespace>/<sha256(key)>`. */
export function cacheLocation(
  environment: Environment,
  namespace: string,
  key: string,
): CacheLocation {
  const directory = join(environment.homeDir, "agents", ".cache", namespace);
  const hash = createHash("sha256").update(key, "utf8").digest("hex");
  return { directory, path: join(directory, hash) };
}

/** Reads one entry's JSON envelope, or `undefined` for any reason it cannot be used. */
export async function readCacheEnvelope(
  location: CacheLocation,
  maxBytes: number,
): Promise<Record<string, unknown> | undefined> {
  try {
    const contents = await CACHE_READER.read(location.path, { maxBytes });
    if (!contents.exists || contents.problem !== undefined || contents.content === undefined) {
      return undefined;
    }
    const value: unknown = JSON.parse(contents.content);
    return isPlainRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Stores one entry's envelope, treating any write failure as nothing having happened. */
export async function writeCacheEnvelope(
  location: CacheLocation,
  envelope: Record<string, unknown>,
): Promise<void> {
  const temporary = join(location.directory, `.${randomUUID()}.tmp`);
  try {
    await mkdir(location.directory, { mode: 0o700, recursive: true });
    await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, location.path);
  } catch {
    // Cache failure never changes whether the validated authoritative document can be used.
    try {
      await unlink(temporary);
    } catch {
      // A failed cache write may not have created its temporary file.
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
