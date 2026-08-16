import type { AuraManifestProblem } from "@tryaura/aura-sdk";

/** A manifest cannot be serialized or written without risking data loss. */
export class AuraManifestError extends Error {
  readonly path: string;
  readonly problem: AuraManifestProblem;

  constructor(path: string, problem: AuraManifestProblem, cause?: unknown) {
    super(problem.message, { cause });
    this.name = "AuraManifestError";
    this.path = path;
    this.problem = problem;
  }
}
