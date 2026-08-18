/**
 * Pure guards over server-supplied names and paths, run before anything derived from a fetched
 * skill can reach a filesystem write.
 *
 * Returned reasons never echo the offending value: they travel in diagnostics, and a hostile path
 * is exactly the kind of string that should not be replayed into a terminal.
 */

/** Shared grammar for source-local skill ids: one kebab-case path component. */
const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const DRIVE_PREFIX_PATTERN = /^[A-Za-z]:/u;
const MAX_PATH_LENGTH = 1024;

/** Why an id is not a single safe path component, or `undefined` when it is. */
export function skillIdProblem(id: string): string | undefined {
  if (id.length > 64 || !SKILL_ID_PATTERN.test(id)) {
    return "is not a kebab-case skill ID of at most 64 characters";
  }
  return undefined;
}

/** Why a fetched path cannot be written under the shared skills root, or `undefined` when it can. */
export function skillFilePathProblem(path: string): string | undefined {
  if (path.length === 0) {
    return "is empty";
  }
  if (path.length > MAX_PATH_LENGTH) {
    return `is longer than ${String(MAX_PATH_LENGTH)} characters`;
  }
  if (path.includes("\\")) {
    return "contains a backslash";
  }
  if (path.startsWith("/")) {
    return "is absolute";
  }
  if (DRIVE_PREFIX_PATTERN.test(path)) {
    return "starts with a drive prefix";
  }
  if (path.startsWith("~")) {
    return "starts with a home reference";
  }
  for (const component of path.split("/")) {
    if (component === "" || component === "." || component === "..") {
      return "contains an empty, dot, or dot-dot component";
    }
  }
  return undefined;
}
