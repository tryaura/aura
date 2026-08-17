import { relative, resolve, sep } from "node:path";

import type { FileOperation, SharedSkillEntry } from "@tryaura/aura-sdk";

export function removeSkillEntries(entries: readonly SharedSkillEntry[]): FileOperation[] {
  return [...entries]
    .sort((left, right) => right.path.length - left.path.length)
    .map((entry) => ({ path: entry.path, type: "remove" }));
}

export function skillIdentity(source: string, id: string): string {
  return `${source}\0${id}`;
}

export function isStrictDescendant(root: string, candidate: string): boolean {
  const difference = relative(resolve(root), resolve(candidate));
  return (
    difference.length > 0 &&
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !difference.startsWith(sep)
  );
}
