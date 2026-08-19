import { resolve } from "node:path";

import type { FileProblem, WorkspaceModel } from "@tryaura/aura-sdk";

import { FILE_PROBLEM_MESSAGES } from "../file-problem-messages.js";
import { comparablePath } from "./claims.js";
import type { ValidatedOperation } from "./path-policy.js";

export type SourceProblemIndex = ReadonlyMap<string, FileProblem>;

/** Indexes scan-time read failures by the same path identity the fix-plan policy uses. */
export function sourceProblemIndex(
  model: WorkspaceModel,
  caseInsensitive: boolean,
): SourceProblemIndex {
  const problems = new Map<string, FileProblem>();
  for (const app of model.apps) {
    for (const source of app.sourceFiles) {
      if (source.problem !== undefined) {
        const key = comparablePath(resolve(source.spec.path), caseInsensitive);
        if (!problems.has(key)) {
          problems.set(key, source.problem);
        }
      }
    }
  }
  return problems;
}

/** Describes the first declared source a plan would mutate despite an unsafe scan read. */
export function sourceProblemRefusal(
  operation: ValidatedOperation,
  problems: SourceProblemIndex,
  caseInsensitive: boolean,
): string | undefined {
  for (const path of operation.paths) {
    const problem = problems.get(comparablePath(resolve(path), caseInsensitive));
    if (problem !== undefined) {
      // Leads with what went wrong and closes with what to do about it, rather than with the enum
      // token: a conflict is rendered to the user verbatim, so it has to read as a sentence.
      return `Aura could not read ${path} during the scan: ${FILE_PROBLEM_MESSAGES[problem]}. Changing it now could discard content Aura never read; fix the file, then re-run`;
    }
  }
  return undefined;
}
