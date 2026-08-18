import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Environment } from "@tryaura/aura-sdk";

import { MAX_TEAM_PRESET_BYTES } from "../workspace/reader-limits.js";
import { createFileReader } from "../workspace/reader.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_CACHE_BYTES = MAX_TEAM_PRESET_BYTES + 4_096;

/**
 * The cache's own reader, built once rather than per lookup.
 *
 * Deliberately not the caller's injected reader: entries are written here with `node:fs` and are
 * machine state rather than workspace content, so reading them through a substituted reader would
 * let a run see a cache it cannot write and write one it cannot see.
 */
const CACHE_READER = createFileReader();

interface CacheEntry {
  readonly cachedAt: number;
  readonly preset: string;
  readonly reference: string;
}

/**
 * Returns the cached document for one reference, or `undefined` for any reason it cannot be used.
 *
 * Every failure is a miss rather than an error: the cache is an optimization, and a corrupt or
 * expired entry must never be the reason a run cannot resolve a preset it could otherwise fetch.
 * The text is returned unvalidated — the caller validates every document it loads, cached or not,
 * so validating here would only duplicate that walk.
 */
// fallow-ignore-next-line complexity -- every branch treats one malformed or stale cache condition as a miss.
export async function readPresetCache(
  environment: Environment,
  reference: string,
): Promise<string | undefined> {
  try {
    const contents = await CACHE_READER.read(cachePath(environment, reference), {
      maxBytes: MAX_CACHE_BYTES,
    });
    if (!contents.exists || contents.problem !== undefined || contents.content === undefined) {
      return undefined;
    }
    const value: unknown = JSON.parse(contents.content);
    if (!isPlainRecord(value)) {
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
  } catch {
    return undefined;
  }
}

/** Stores one validated document, treating any write failure as nothing having happened. */
export async function writePresetCache(
  environment: Environment,
  reference: string,
  preset: string,
): Promise<void> {
  const path = cachePath(environment, reference);
  const directory = cacheDirectory(environment);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const entry: CacheEntry = { cachedAt: environment.now().getTime(), preset, reference };
  try {
    await mkdir(directory, { mode: 0o700, recursive: true });
    await writeFile(temporary, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } catch {
    // Cache failure never changes whether a validated authoritative preset can be used this run.
    try {
      await unlink(temporary);
    } catch {
      // A failed cache write may not have created its temporary file.
    }
  }
}

function cacheDirectory(environment: Environment): string {
  return join(environment.homeDir, "agents", ".cache", "presets");
}

function cachePath(environment: Environment, reference: string): string {
  const hash = createHash("sha256").update(reference, "utf8").digest("hex");
  return join(cacheDirectory(environment), hash);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
