import type { WorkspaceModel } from "@tryaura/aura-sdk";
import { displayPath } from "@tryaura/core/display-path";

/** Names an instruction file the way a user can address it from the current workspace. */
export function displayInstructionPath(path: string, model: WorkspaceModel): string {
  return displayPath(path, {
    cwd: model.cwd,
    homeDir: model.homeDir,
    ...(model.projectRoot === undefined ? {} : { projectRoot: model.projectRoot }),
  });
}

export function instructionLineRange(startLine: number, endLine: number): string {
  return startLine === endLine ? String(startLine) : `${String(startLine)}-${String(endLine)}`;
}
