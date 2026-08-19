/**
 * The one walker every skill tree is read through, and the policy that hardens it.
 *
 * Bundled and already-installed trees are local state Aura itself wrote, so they walk unbounded.
 * A driver-materialized tree is whatever a plugin's driver put on disk — the reviewed origin is a
 * claim, not a guarantee — so it walks under {@link DRIVER_WALK_POLICY}, which caps file size,
 * file count, and total bytes, refuses paths that will not survive a portable filesystem, and
 * refuses two paths that would alias on a case-insensitive one.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";

import type { FileProblem, ResolvedSkillFile, SharedSkillEntry } from "@tryaura/aura-sdk";

import {
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_RESPONSE_BYTES,
} from "../skills/limits.js";
import { portableSkillFilePathKey, skillFilePathProblem } from "../skills/path-guards.js";
import type { FileReader, PathContents } from "./reader.js";

export interface WalkedTree {
  readonly entries: readonly SharedSkillEntry[];
  readonly files: readonly ResolvedSkillFile[];
  readonly problem?: WalkProblem | undefined;
}

interface WalkProblem {
  readonly kind: FileProblem;
  readonly message: string;
}

interface WalkPolicy {
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
}

interface WalkState {
  readonly portablePaths: Set<string>;
  totalBytes: number;
}

/** The tree being walked, as the caller spelled it and as the filesystem canonicalizes it. */
interface WalkRoot {
  /**
   * Canonical directory every file read must land inside.
   *
   * Resolved once, because the caller's spelling routinely is not canonical — a temporary
   * directory on macOS reaches its files through a symlink — and a boundary that does not match
   * what the filesystem answers would refuse the whole tree.
   */
  readonly boundary: string;
  /** The root as it was given, which every reported path stays relative to. */
  readonly path: string;
}

/** The bounds an untrusted, driver-supplied tree is read under. */
export const DRIVER_WALK_POLICY: WalkPolicy = Object.freeze({
  maxFileBytes: MAX_SKILL_FILE_BYTES,
  maxFiles: MAX_SKILL_FILES,
  maxTotalBytes: MAX_SKILL_RESPONSE_BYTES,
});

/** Deterministic, platform-independent signature of a normalized skill tree. */
export function treeHash(files: readonly ResolvedSkillFile[]): string {
  const signature = [...files]
    .map((file) => ({ ...file, path: file.path.replaceAll("\\", "/") }))
    .sort((left, right) => comparePortablePaths(left.path, right.path))
    .map(
      (file) => `f:${file.path}:${createHash("sha256").update(file.content, "utf8").digest("hex")}`,
    )
    .join("\n");
  return createHash("sha256").update(`${signature}\n`, "utf8").digest("hex");
}

/** Reads one skill directory, stopping at the first entry it cannot safely resolve. */
export async function walkTree(
  root: string,
  reader: FileReader,
  policy?: WalkPolicy,
): Promise<WalkedTree> {
  const files: ResolvedSkillFile[] = [];
  const entries: SharedSkillEntry[] = [];
  const state: WalkState = { portablePaths: new Set(), totalBytes: 0 };
  const path = resolve(root);
  const walkRoot: WalkRoot = { boundary: (await reader.realPath(path)) ?? path, path };
  const problem = await walkPath(walkRoot, path, reader, files, entries, state, policy);
  return {
    entries: Object.freeze(entries),
    files: Object.freeze(files.sort((left, right) => comparePortablePaths(left.path, right.path))),
    ...(problem === undefined ? {} : { problem }),
  };
}

// fallow-ignore-next-line complexity -- every branch rejects or resolves one filesystem entry kind.
async function walkPath(
  root: WalkRoot,
  path: string,
  reader: FileReader,
  files: ResolvedSkillFile[],
  entries: SharedSkillEntry[],
  state: WalkState,
  policy?: WalkPolicy,
): Promise<WalkProblem | undefined> {
  // Bounded, because the tree a driver materialized is whatever that driver wrote: an entry
  // swapped for a link between the walk deciding what it is and the read capturing it would
  // otherwise deliver a file from outside the tree under a name from inside it. `readWithin` reads
  // from the object it verified, so contents can only come from within the tree.
  const { contents } = await reader.readWithin(
    path,
    [root.boundary],
    policy === undefined ? undefined : { maxBytes: policy.maxFileBytes },
  );
  const relativePath = portablePath(relative(root.path, path));
  if (!contents.exists) {
    return {
      kind: "unreadable",
      message: `${relativePath || "."} does not exist`,
    };
  }
  if (contents.pathKind === "symlink") {
    return {
      kind: "unsupported",
      message: `${relativePath || "."} is a symbolic link`,
    };
  }
  if (contents.problem !== undefined) {
    return {
      kind: contents.problem,
      message: `${relativePath || "."} could not be read (${contents.problem})`,
    };
  }
  if (contents.entries !== undefined) {
    entries.push({ kind: "directory", path });
    for (const entry of contents.entries) {
      const problem = await walkPath(
        root,
        join(path, entry),
        reader,
        files,
        entries,
        state,
        policy,
      );
      if (problem !== undefined) {
        return problem;
      }
    }
    return undefined;
  }
  return addFile(path, relativePath, contents, files, entries, state, policy);
}

// fallow-ignore-next-line complexity -- every branch rejects one unsafe filesystem outcome.
function addFile(
  path: string,
  relativePath: string,
  contents: PathContents,
  files: ResolvedSkillFile[],
  entries: SharedSkillEntry[],
  state: WalkState,
  policy?: WalkPolicy,
): WalkProblem | undefined {
  if (contents.content === undefined) {
    return {
      kind: "unsupported",
      message: `${relativePath} is not a readable regular file`,
    };
  }
  if (contents.utf8Valid === false) {
    return {
      kind: "unsupported",
      message: `${relativePath} is not valid UTF-8`,
    };
  }
  if (policy !== undefined) {
    if (
      skillFilePathProblem(relativePath) !== undefined ||
      contents.size === undefined ||
      contents.size > policy.maxFileBytes ||
      files.length >= policy.maxFiles
    ) {
      return { kind: "unsupported", message: `${relativePath} is not a safe skill file` };
    }
    const portablePath = portableSkillFilePathKey(relativePath);
    if (state.portablePaths.has(portablePath)) {
      return { kind: "unsupported", message: `${relativePath} aliases another skill file` };
    }
    const bytes = Buffer.byteLength(contents.content, "utf8");
    if (state.totalBytes + bytes > policy.maxTotalBytes) {
      return { kind: "too-large", message: `${relativePath} exceeds the skill size limit` };
    }
    state.portablePaths.add(portablePath);
    state.totalBytes += bytes;
  }
  entries.push({ kind: "file", path });
  files.push({ content: contents.content, path: relativePath });
  return undefined;
}

function portablePath(path: string): string {
  return sep === "/" ? path : path.replaceAll(sep, "/");
}

function comparePortablePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
