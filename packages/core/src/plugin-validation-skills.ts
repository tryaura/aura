import type { Adapter } from "@tryaura/aura-sdk";

import type { RegistryState } from "./plugin-validation.js";

/** Rejects skill destinations that are empty, duplicated, or outside the user's home directory. */
export function collectSkillDirectoryViolations(
  state: RegistryState,
  adapter: Adapter,
  pluginLabel: string,
): void {
  const directories = adapter.capabilities?.skills?.directories;
  if (directories === undefined) {
    return;
  }
  if (directories.length === 0) {
    state.violations.push(
      `${pluginLabel} adapter "${adapter.id}" declares Agent Skills support without a global skills directory.`,
    );
    return;
  }

  const ids = new Set<string>();
  for (const directory of directories) {
    if (ids.has(directory.id)) {
      state.violations.push(
        `${pluginLabel} adapter "${adapter.id}" declares duplicate skills directory ID "${directory.id}".`,
      );
    }
    ids.add(directory.id);
    if (!isGlobalSkillPath(directory.entryPath)) {
      state.violations.push(
        `${pluginLabel} adapter "${adapter.id}" declares invalid global skills directory ${directory.entryPath}.`,
      );
    }
  }
}

function isGlobalSkillPath(entryPath: string): boolean {
  const relative = entryPath.startsWith("~/") ? entryPath.slice(2) : undefined;
  return (
    relative !== undefined &&
    relative.length > 0 &&
    !relative.includes("\\") &&
    !relative.includes("\0") &&
    relative
      .split("/")
      .every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}
