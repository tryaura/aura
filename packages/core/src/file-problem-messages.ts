import type { FileProblem } from "@tryaura/aura-sdk";

/**
 * How each {@link FileProblem} reads inside a user-facing sentence.
 *
 * One table rather than one per caller, so the same enum value cannot be described two different
 * ways in the same report. The limit-bearing entries stay generic here; a caller that knows the
 * limit it applied wraps this table and overrides them with the number (see `workspace/specs.ts`).
 */
export const FILE_PROBLEM_MESSAGES: Readonly<Record<FileProblem, string>> = {
  denied: "permission was denied",
  loop: "the path is a loop of symbolic links",
  "outside-project": "the path resolves outside the project",
  resources: "the system ran out of resources while reading it",
  "too-large": "the file is too large to read safely",
  "too-many-entries": "the path contains too many entries",
  unreadable: "the filesystem reported an error",
  unsupported: "the path is not a readable regular file",
};
