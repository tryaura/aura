import { embeddedDirectoryEntries } from "./embedded-assets.js";
import { MAX_DIRECTORY_ENTRIES } from "./reader-limits.js";
import type { PathContents } from "./reader.js";

/** Reads a parent directory Bun omitted from its otherwise file-addressable virtual filesystem. */
export function readEmbeddedDirectory(path: string): PathContents | undefined {
  const entries = embeddedDirectoryEntries(path);
  if (entries === undefined) {
    return undefined;
  }
  return entries.length > MAX_DIRECTORY_ENTRIES
    ? {
        exists: true,
        isDirectory: true,
        pathKind: "directory",
        problem: "too-many-entries",
      }
    : { entries, exists: true, isDirectory: true, pathKind: "directory" };
}
