import type {
  AppModel,
  GitignoreModel,
  InstructionDocument,
  RepositoryPackageManifest,
  WorkspaceModel,
} from "@tryaura/aura-sdk";

import { model } from "./testing.js";

/** Where the repository state a project-scoped check reads comes from. */
export interface TestRepositoryOptions {
  readonly apps?: readonly AppModel[];
  readonly infoExclude?: GitignoreModel;
  readonly instructionFiles?: readonly InstructionDocument[];
  readonly packageManifests?: readonly RepositoryPackageManifest[];
  readonly trackedAgentPaths?: readonly string[];
}

/** A workspace whose cwd sits below the repository root, as it usually does in practice. */
export function projectModel(
  rootGitignore: GitignoreModel,
  options: TestRepositoryOptions = {},
): WorkspaceModel {
  return {
    ...model({
      apps: options.apps ?? [],
      instructionFiles: options.instructionFiles ?? [],
    }),
    cwd: "/repo/packages/app",
    projectRoot: "/repo",
    repository: {
      gitignore: rootGitignore,
      packageManifests: options.packageManifests ?? [],
      trackedAgentPaths: options.trackedAgentPaths ?? [],
      ...(options.infoExclude === undefined ? {} : { infoExclude: options.infoExclude }),
    },
  };
}

export function gitignore(
  content: string,
  exists = true,
  path = "/repo/.gitignore",
): GitignoreModel {
  return {
    content,
    exists,
    path,
    patterns: content
      .split(/\r?\n/u)
      .flatMap((value, index) =>
        value.trim() === "" || value.startsWith("#") ? [] : [{ line: index + 1, value }],
      ),
  };
}
