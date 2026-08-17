import type { AuraManifestProblem, AuraManifestState, FileProblem } from "@tryaura/aura-sdk";

import { FILE_PROBLEM_MESSAGES } from "../file-problem-messages.js";
import type { PathContents } from "../workspace/reader.js";
import { parseAuraManifest } from "./codec.js";

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
