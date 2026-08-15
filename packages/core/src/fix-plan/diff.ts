import { isUtf8 } from "node:buffer";

import { createTwoFilesPatch } from "diff";

import type { PathState } from "./state.js";

const NULL_PATH = "/dev/null";

export function renderWriteDiff(path: string, before: PathState, content: string): string {
  const previous = textOf(before);
  if (previous === undefined) {
    return renderBinaryChange("write", path);
  }

  return renderPatch(
    "write",
    path,
    before.kind === "missing" ? NULL_PATH : path,
    path,
    previous,
    content,
  );
}

export function renderRemoveDiff(path: string, before: PathState): string {
  if (before.kind === "directory") {
    return [`diff --aura remove ${path}`, `remove empty directory ${path}`, ""].join("\n");
  }

  const previous = textOf(before);
  if (previous === undefined) {
    return renderBinaryChange("remove", path);
  }

  return renderPatch("remove", path, path, NULL_PATH, previous, "");
}

export function renderMoveDiff(sourcePath: string, destinationPath: string): string {
  return [
    `diff --aura move ${sourcePath} ${destinationPath}`,
    `rename from ${sourcePath}`,
    `rename to ${destinationPath}`,
    "",
  ].join("\n");
}

export function renderSymlinkDiff(path: string, before: PathState, target: string): string {
  const previous = textOf(before);
  if (previous === undefined) {
    return renderBinaryChange("symlink", path);
  }

  const patch = renderPatch(
    "symlink",
    path,
    before.kind === "missing" ? NULL_PATH : path,
    path,
    previous,
    `${target}\n`,
  );
  return `${patch}link target ${target}\n`;
}

function renderPatch(
  operation: string,
  displayPath: string,
  oldPath: string,
  newPath: string,
  oldContent: string,
  newContent: string,
): string {
  const patch = createTwoFilesPatch(oldPath, newPath, oldContent, newContent, "before", "after", {
    context: 3,
  });
  return `diff --aura ${operation} ${displayPath}\n${patch}`;
}

function renderBinaryChange(operation: string, path: string): string {
  return [
    `diff --aura ${operation} ${path}`,
    `Binary or oversized file ${path} would change.`,
    "",
  ].join("\n");
}

function textOf(state: PathState): string | undefined {
  switch (state.kind) {
    case "directory": {
      return undefined;
    }
    case "file": {
      return state.content !== undefined && isUtf8(state.content)
        ? state.content.toString("utf8")
        : undefined;
    }
    case "missing": {
      return "";
    }
    case "symlink": {
      return `${state.target}\n`;
    }
  }
}
