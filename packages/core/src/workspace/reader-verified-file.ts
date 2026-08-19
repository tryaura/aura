import { isUtf8 } from "node:buffer";
import type { Stats } from "node:fs";
import { realpath, stat, type FileHandle } from "node:fs/promises";

import { readFileHandlePrefix } from "./reader-file-handle.js";
import { resolvedMetadata } from "./reader-filesystem.js";
import { MAX_FILE_BYTES } from "./reader-limits.js";
import type { FileReadOptions, PathContents } from "./reader.js";

/** Captures content from the same handle whose identity passed project containment validation. */
export async function readVerifiedFileContents(
  file: FileHandle,
  stats: Stats,
  pathKind: "directory" | "file" | "symlink",
  symlinkTarget: string | undefined,
  options: FileReadOptions | undefined,
): Promise<PathContents> {
  const metadata = resolvedMetadata(stats, pathKind, symlinkTarget, options);
  const maxBytes = options?.maxBytes;
  if (maxBytes === undefined && stats.size > MAX_FILE_BYTES) {
    return { ...metadata, exists: true, isDirectory: false, problem: "too-large" };
  }

  const content =
    maxBytes === undefined
      ? await file.readFile()
      : await readFileHandlePrefix(file, Math.min(maxBytes, stats.size));
  return {
    ...metadata,
    content: content.toString("utf8"),
    exists: true,
    isDirectory: false,
    ...(maxBytes === undefined || stats.size <= maxBytes
      ? isUtf8(content)
        ? {}
        : { utf8Valid: false }
      : {}),
  };
}

/** A canonical path together with the identity of the object standing at it. */
export interface ResolvedIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly path: string;
}

/** Canonicalizes a path and reads the identity of whatever it lands on, or nothing when it fails. */
export async function resolvedIdentity(path: string): Promise<ResolvedIdentity | undefined> {
  try {
    const resolvedPath = await realpath(path);
    const stats = await stat(resolvedPath, { bigint: true });
    return { dev: stats.dev, ino: stats.ino, path: resolvedPath };
  } catch {
    return undefined;
  }
}

/**
 * Whether two stat results describe the same filesystem object.
 *
 * Identity is asked in 64-bit form because that is the width it is stored in: a Windows file index
 * loses its low bits once it passes 2^53 as a double, and the collisions that follow are exactly
 * the ones this comparison exists to catch. A filesystem that answers `0` — some network mounts and
 * older Windows volumes — is not answering at all, so it is treated as a failed check rather than a
 * match, and its caller refuses the read instead of trusting an identity nobody vouched for.
 */
export function sameIdentity(left: Identity, right: Identity): boolean {
  return left.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
}

interface Identity {
  readonly dev: bigint;
  readonly ino: bigint;
}
