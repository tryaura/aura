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
const WINDOWS_RESERVED_CHARACTER_PATTERN = /[<>:"|?*]/u;
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:aux|con|nul|prn|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu;
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
  const pathProblem = generalPathProblem(path);
  if (pathProblem !== undefined) {
    return pathProblem;
  }
  for (const component of path.split("/")) {
    const componentProblem = portableComponentProblem(component);
    if (componentProblem !== undefined) {
      return componentProblem;
    }
  }
  return undefined;
}

/** Checks constraints that apply to the whole relative path rather than one component. */
function generalPathProblem(path: string): string | undefined {
  if (path.length === 0) {
    return "is empty";
  }
  if (path.length > MAX_PATH_LENGTH) {
    return `is longer than ${String(MAX_PATH_LENGTH)} characters`;
  }
  if (path.includes("\\")) {
    return "contains a backslash";
  }
  if (hasControlCharacter(path)) {
    return "contains a control character";
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
  return undefined;
}

/** Checks one path component against portable filesystem spelling rules. */
function portableComponentProblem(component: string): string | undefined {
  if (component === "" || component === "." || component === "..") {
    return "contains an empty, dot, or dot-dot component";
  }
  if (WINDOWS_RESERVED_CHARACTER_PATTERN.test(component)) {
    return "contains a character reserved by Windows";
  }
  if (component.endsWith(".") || component.endsWith(" ")) {
    return "contains a component ending in a dot or space";
  }
  if (WINDOWS_RESERVED_NAME_PATTERN.test(component)) {
    return "contains a device name reserved by Windows";
  }
  return undefined;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

/** Portable comparison key used to refuse paths that alias on common filesystems. */
export function portableSkillFilePathKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}
