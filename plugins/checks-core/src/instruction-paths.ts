import { isAbsolute, relative, sep } from "node:path";

import type { WorkspaceModel } from "@tryaura/aura-sdk";

/** Names an instruction file the way a user can address it from the current workspace. */
export function displayInstructionPath(path: string, model: WorkspaceModel): string {
  const projectPath = pathInside(model.projectRoot ?? model.cwd, path);
  if (projectPath !== undefined) {
    return projectPath;
  }
  const homePath = pathInside(model.homeDir, path);
  return homePath === undefined ? path : `~/${homePath}`;
}

export function instructionLineRange(startLine: number, endLine: number): string {
  return startLine === endLine ? String(startLine) : `${String(startLine)}-${String(endLine)}`;
}

function pathInside(root: string, path: string): string | undefined {
  const difference = relative(root, path);
  if (
    difference.length === 0 ||
    difference === ".." ||
    difference.startsWith(`..${sep}`) ||
    isAbsolute(difference)
  ) {
    return undefined;
  }
  return difference.split(sep).join("/");
}
