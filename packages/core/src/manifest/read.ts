import type { AuraManifestProblem, AuraManifestState, FileProblem } from "@tryaura/aura-sdk";

import type { PathContents } from "../workspace/reader.js";
import { parseAuraManifest } from "./codec.js";

const FILE_PROBLEM_MESSAGES: Readonly<Record<FileProblem, string>> = {
  denied: "permission was denied",
  loop: "the path is a loop of symbolic links",
  "outside-project": "the path resolves outside the allowed project",
  resources: "the system ran out of resources while reading it",
  "too-large": "the file is too large to read safely",
  "too-many-entries": "the path contains too many entries",
  unreadable: "the filesystem reported an error",
  unsupported: "the path is not a readable regular file",
};

/** Turns core's bounded filesystem read into the manifest state exposed to checks. */
export function readAuraManifest(path: string, contents: PathContents): AuraManifestState {
  if (contents.problem !== undefined) {
    return fileProblem(path, contents.exists, contents.problem);
  }
  if (!contents.exists) {
    return Object.freeze({ exists: false, path, status: "missing" });
  }
  if (contents.content === undefined || contents.isDirectory) {
    return fileProblem(path, true, "unsupported");
  }
  return parseAuraManifest(contents.content, path, contents.mode);
}

function fileProblem(path: string, exists: boolean, reason: FileProblem): AuraManifestState {
  const problem: AuraManifestProblem = {
    kind: "file",
    message: `Aura cannot read ${path}: ${FILE_PROBLEM_MESSAGES[reason]}. Fix access to the file before writing; Aura left it unchanged.`,
    reason,
  };
  return Object.freeze({ exists, path, problem, status: "read-only" });
}
