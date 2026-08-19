import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

import { isEmbeddedAssetPath } from "./embedded-assets.js";
import { containsPath } from "./path-containment.js";
import {
  inspectTarget,
  inspectionResult,
  type InspectedTarget,
  type InspectionResult,
} from "./reader-bounded-target.js";
import { isAbsence, toProblem } from "./reader-errors.js";
import { readDirectory, readPath, resolveRealPath, resolvedMetadata } from "./reader-filesystem.js";
import type { BoundedPathRead, FileReadOptions } from "./reader.js";
import {
  readVerifiedFileContents,
  resolvedIdentity,
  sameIdentity,
} from "./reader-verified-file.js";

/**
 * Reads a path only after proving that the object it leads to is inside one of `directories`.
 *
 * Containment is asked twice, against two different threats. It is asked first from the path
 * alone, before anything is opened, because `open` is not free of consequence: a checked-out
 * repository that points a declared path at a device node, or at a directory the operating system
 * guards behind a consent prompt, would otherwise have Aura open it and only then decide it was
 * out of bounds. It is asked again on the object that was actually opened, because the first
 * answer can be raced — and a regular file stays open from that second check through the read, so
 * swapping a symlink afterwards cannot redirect either a whole-file or a prefix read.
 *
 * A directory has no equivalent guarantee: Node cannot list one from a handle, so the listing is
 * bounded by resolving before and after the read and refusing a target whose identity moved. A
 * swap reverted inside that window stays undetected, which is the one gap this cannot close.
 *
 * Bun's embedded filesystem provides no handles at all, so a compiled binary's own assets are
 * bounded by resolution alone; that asset table is immutable for the life of the process.
 */
export async function readPathWithin(
  path: string,
  directories: readonly string[],
  options?: FileReadOptions,
): Promise<BoundedPathRead> {
  if (isEmbeddedAssetPath(path)) {
    return readEmbeddedPathWithin(path, directories, options);
  }

  const inspection = await inspectTarget(path);
  if (inspection.kind === "result") {
    return inspection.result;
  }

  const refusal = await refuseBeforeOpen(path, directories, inspection, options);
  if (refusal !== undefined) {
    return refusal;
  }

  return inspection.stats.isDirectory()
    ? readDirectoryWithin(path, directories, inspection)
    : readOpenedPathWithin(path, directories, inspection, options);
}

/** Refuses a path that already leads out of bounds, so nothing out there is ever opened. */
async function refuseBeforeOpen(
  path: string,
  directories: readonly string[],
  target: InspectedTarget,
  options: FileReadOptions | undefined,
): Promise<BoundedPathRead | undefined> {
  const candidate = await resolveRealPath(path);
  // A path that will not resolve is not refused here. It may still be readable, and the identity
  // check on the opened object is the one entitled to decide what could not be verified.
  return candidate === undefined || insideAny(directories, candidate)
    ? undefined
    : outside(target, candidate, options);
}

async function readOpenedPathWithin(
  path: string,
  directories: readonly string[],
  target: InspectedTarget,
  options: FileReadOptions | undefined,
): Promise<BoundedPathRead> {
  const opened = await openFile(path, target, options);
  if (opened.kind === "result") {
    return opened.result;
  }

  try {
    return await readOpenedFile(opened.file, path, directories, target, options);
  } catch (error) {
    return readFailure(error, target, options);
  } finally {
    try {
      await opened.file.close();
    } catch {
      // The content result remains valid even when releasing its already-consumed handle fails.
    }
  }
}

interface OpenedFile {
  readonly file: FileHandle;
  readonly kind: "file";
}

async function openFile(
  path: string,
  target: InspectedTarget,
  options: FileReadOptions | undefined,
): Promise<OpenedFile | InspectionResult> {
  try {
    // Non-blocking, because a named pipe inside the project would otherwise hold the scan open
    // until something on the other end decided to write.
    return { file: await open(path, constants.O_RDONLY | constants.O_NONBLOCK), kind: "file" };
  } catch (error) {
    return inspectionResult(
      isAbsence(error)
        ? { contents: { exists: false, isDirectory: false }, kind: "read" }
        : readFailure(error, target, options),
    );
  }
}

async function readOpenedFile(
  file: FileHandle,
  path: string,
  directories: readonly string[],
  target: InspectedTarget,
  options: FileReadOptions | undefined,
): Promise<BoundedPathRead> {
  // Identity is asked of the handle in 64-bit form and the metadata below in the ordinary one,
  // which is two calls on an already-open descriptor: no path is walked twice, and the alternative
  // is converting widths by hand on every field a reader reports.
  const identity = await file.stat({ bigint: true });
  const resolved = await resolvedIdentity(path);
  if (resolved === undefined || !sameIdentity(resolved, identity)) {
    return unverified(target, options);
  }
  if (!insideAny(directories, resolved.path)) {
    return outside(target, resolved.path, options);
  }

  const openedStats = await file.stat();
  if (!openedStats.isFile()) {
    return {
      contents: {
        ...resolvedMetadata(openedStats, target.pathKind, target.symlinkTarget, options),
        exists: true,
        isDirectory: false,
        problem: "unsupported",
      },
      kind: "read",
      resolvedPath: resolved.path,
    };
  }
  return {
    contents: await readVerifiedFileContents(
      file,
      openedStats,
      target.pathKind,
      target.symlinkTarget,
      options,
    ),
    kind: "read",
    resolvedPath: resolved.path,
  };
}

async function readDirectoryWithin(
  path: string,
  directories: readonly string[],
  target: InspectedTarget,
): Promise<BoundedPathRead> {
  const before = await resolvedIdentity(path);
  if (before === undefined) {
    return unverified(target);
  }
  if (!insideAny(directories, before.path)) {
    return outside(target, before.path);
  }

  const metadata = resolvedMetadata(target.stats, target.pathKind, target.symlinkTarget);
  const contents = await readDirectory(path, metadata);
  const after = await resolvedIdentity(path);
  if (after === undefined || after.path !== before.path || !sameIdentity(after, before)) {
    return unverified(target);
  }
  return { contents, kind: "read", resolvedPath: before.path };
}

function insideAny(directories: readonly string[], path: string): boolean {
  return directories.some((directory) => containsPath(directory, path));
}

function readFailure(
  error: unknown,
  target: InspectedTarget,
  options: FileReadOptions | undefined,
): BoundedPathRead {
  return {
    contents: {
      ...resolvedMetadata(target.stats, target.pathKind, target.symlinkTarget, options),
      exists: true,
      isDirectory: false,
      problem: toProblem(error),
    },
    kind: "read",
  };
}

function outside(
  target: InspectedTarget,
  resolvedPath: string,
  options?: FileReadOptions,
): BoundedPathRead {
  return {
    contents: {
      ...resolvedMetadata(target.stats, target.pathKind, target.symlinkTarget, options),
      exists: true,
      isDirectory: target.stats.isDirectory(),
      problem: "outside-project",
    },
    kind: "outside",
    resolvedPath,
  };
}

function unverified(target: InspectedTarget, options?: FileReadOptions): BoundedPathRead {
  return {
    contents: {
      ...resolvedMetadata(target.stats, target.pathKind, target.symlinkTarget, options),
      exists: true,
      isDirectory: target.stats.isDirectory(),
      problem: "unreadable",
    },
    kind: "unverified",
  };
}

async function readEmbeddedPathWithin(
  path: string,
  directories: readonly string[],
  options: FileReadOptions | undefined,
): Promise<BoundedPathRead> {
  const resolvedPath = await resolveRealPath(path);
  if (resolvedPath !== undefined && !insideAny(directories, resolvedPath)) {
    return {
      contents: { exists: true, isDirectory: false, problem: "outside-project" },
      kind: "outside",
      resolvedPath,
    };
  }
  return {
    contents: await readPath(path, options),
    kind: "read",
    ...(resolvedPath === undefined ? {} : { resolvedPath }),
  };
}
