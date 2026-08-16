import { Buffer, isUtf8 } from "node:buffer";

import type { FileMode } from "@tryaura/aura-sdk";
import { createTwoFilesPatch } from "diff";

import { MAX_DIFF_BYTES } from "./limits.js";
import type { PathState } from "./state.js";

const NULL_PATH = "/dev/null";

export function renderWriteDiff(
  path: string,
  before: PathState,
  content: string,
  requestedMode: FileMode | undefined,
  mode: number,
): string {
  const note = modeNote(before, requestedMode, mode);
  const previous = textOf(before);
  if (previous === undefined) {
    return renderSummary("write", path, "Binary or oversized file would change.") + note;
  }
  if (exceedsDiffBudget(previous, content)) {
    return renderSummary("write", path, "File is too large to diff; contents would change.") + note;
  }

  return (
    renderPatch(
      "write",
      path,
      before.kind === "missing" ? NULL_PATH : path,
      path,
      previous,
      content,
    ) + note
  );
}

export function renderRemoveDiff(path: string, before: PathState): string {
  if (before.kind === "directory") {
    return renderSummary("remove", path, "Remove empty directory.");
  }

  const previous = textOf(before);
  if (previous === undefined) {
    return renderSummary("remove", path, "Binary or oversized file would be removed.");
  }
  if (exceedsDiffBudget(previous, "")) {
    return renderSummary("remove", path, "File is too large to diff; it would be removed.");
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
    return renderSummary("symlink", path, `Binary or oversized file would become a link.`);
  }
  if (exceedsDiffBudget(previous, target)) {
    return renderSummary("symlink", path, "File is too large to diff; it would become a link.");
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

/** Describes a conflict in the same shape as a diff, so a renderer can treat previews uniformly. */
export function renderConflict(operation: string, path: string, reason: string): string {
  return renderSummary(operation, path, `Blocked: ${reason}.`);
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

function renderSummary(operation: string, path: string, detail: string): string {
  return [`diff --aura ${operation} ${path}`, detail, ""].join("\n");
}

/**
 * Says what happens to an existing file's permissions.
 *
 * Two cases are worth a line. A mode that changes is a change the diff itself cannot show, and core
 * only does that to files it owns as protocol. A `mode` a plan asked for and will not get is the
 * commoner one: an existing file keeps whatever the user set, and saying so is the difference
 * between a deliberate choice and a silent one.
 */
function modeNote(before: PathState, requestedMode: FileMode | undefined, mode: number): string {
  if (before.kind !== "file") {
    return "";
  }
  if (before.mode !== mode) {
    return `mode ${formatMode(before.mode)} changes to ${formatMode(mode)}\n`;
  }
  if (requestedMode !== undefined && requestedMode !== before.mode) {
    return `mode ${formatMode(requestedMode)} requested; existing mode ${formatMode(before.mode)} is preserved\n`;
  }

  return "";
}

function formatMode(mode: number): string {
  return `0o${mode.toString(8).padStart(3, "0")}`;
}

function exceedsDiffBudget(before: string, after: string): boolean {
  return Buffer.byteLength(before, "utf8") + Buffer.byteLength(after, "utf8") > MAX_DIFF_BYTES;
}

function textOf(state: PathState): string | undefined {
  switch (state.kind) {
    case "directory":
    case "unsupported": {
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
