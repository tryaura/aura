import type { FileOperation, SharedSkillEntry } from "@tryaura/aura-sdk";

export function removeSkillEntries(entries: readonly SharedSkillEntry[]): FileOperation[] {
  return [...entries]
    .sort((left, right) => right.path.length - left.path.length)
    .map((entry) => ({ path: entry.path, type: "remove" }));
}

export function skillIdentity(source: string, id: string): string {
  return `${source}\0${id}`;
}
