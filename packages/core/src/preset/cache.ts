import type { Environment } from "@tryaura/aura-sdk";

import { MAX_TEAM_PRESET_BYTES } from "../workspace/reader-limits.js";
import { cacheLocation, readCacheEnvelope, writeCacheEnvelope } from "../workspace/disk-cache.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_CACHE_BYTES = MAX_TEAM_PRESET_BYTES + 4_096;

const NAMESPACE = "presets";

/**
 * Returns the cached document for one reference, or `undefined` for any reason it cannot be used.
 *
 * Every failure is a miss rather than an error: the cache is an optimization, and a corrupt or
 * expired entry must never be the reason a run cannot resolve a preset it could otherwise fetch.
 * The text is returned unvalidated — the caller validates every document it loads, cached or not,
 * so validating here would only duplicate that walk.
 */
export async function readPresetCache(
  environment: Environment,
  reference: string,
): Promise<string | undefined> {
  const value = await readCacheEnvelope(
    cacheLocation(environment, NAMESPACE, reference),
    MAX_CACHE_BYTES,
  );
  if (value === undefined) {
    return undefined;
  }
  const cachedAt = value["cachedAt"];
  const preset = value["preset"];
  const now = environment.now().getTime();
  if (
    typeof cachedAt !== "number" ||
    typeof preset !== "string" ||
    value["reference"] !== reference ||
    cachedAt > now ||
    now - cachedAt > CACHE_TTL_MS
  ) {
    return undefined;
  }
  return preset;
}

/** Stores one validated document, treating any write failure as nothing having happened. */
export async function writePresetCache(
  environment: Environment,
  reference: string,
  preset: string,
): Promise<void> {
  await writeCacheEnvelope(cacheLocation(environment, NAMESPACE, reference), {
    cachedAt: environment.now().getTime(),
    preset,
    reference,
  });
}
