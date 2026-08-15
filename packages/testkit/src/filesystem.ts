import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { createTwoFilesPatch } from "diff";

import type { TestFileDiff, TestFileDiffStatus, TestSeed } from "./types.js";

interface FileEntry {
  readonly kind: "file";
  readonly text: string;
}

interface SymlinkEntry {
  readonly kind: "symlink";
  readonly target: string;
}

type TreeEntry = FileEntry | SymlinkEntry;
export type FilesystemSnapshot = ReadonlyMap<string, TreeEntry>;

const NULL_PATH = "/dev/null";

export async function captureFilesystem(seed: TestSeed): Promise<FilesystemSnapshot> {
  const entries = new Map<string, TreeEntry>();
  await Promise.all([
    captureRoot(seed.homeDir, "<HOME>", entries),
    captureRoot(seed.workspaceDir, "<WORKSPACE>", entries),
  ]);
  return entries;
}

export function diffFilesystem(
  before: FilesystemSnapshot,
  after: FilesystemSnapshot,
  normalize: (value: string) => string,
): readonly TestFileDiff[] {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const diffs: TestFileDiff[] = [];

  for (const path of paths) {
    const previous = before.get(path);
    const current = after.get(path);
    if (equalEntry(previous, current)) {
      continue;
    }

    const status = changeStatus(previous, current);
    const oldPath = previous === undefined ? NULL_PATH : path;
    const newPath = current === undefined ? NULL_PATH : path;
    const patch = createTwoFilesPatch(
      oldPath,
      newPath,
      normalize(entryText(previous)),
      normalize(entryText(current)),
      "before",
      "after",
      { context: 3 },
    );
    diffs.push(Object.freeze({ patch, path, status }));
  }

  return Object.freeze(diffs);
}

async function captureRoot(
  root: string,
  label: string,
  entries: Map<string, TreeEntry>,
): Promise<void> {
  await captureDirectory(root, root, label, entries);
}

async function captureDirectory(
  root: string,
  directory: string,
  label: string,
  entries: Map<string, TreeEntry>,
): Promise<void> {
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));

  for (const child of children) {
    const path = join(directory, child.name);
    const logicalPath = `${label}/${toPortablePath(relative(root, path))}`;
    if (child.isDirectory()) {
      await captureDirectory(root, path, label, entries);
      continue;
    }
    if (child.isFile()) {
      entries.set(logicalPath, { kind: "file", text: await readFile(path, "utf8") });
      continue;
    }
    if (child.isSymbolicLink()) {
      entries.set(logicalPath, { kind: "symlink", target: await readlink(path) });
      continue;
    }

    const stats = await lstat(path);
    throw new Error(`Cannot snapshot unsupported fixture entry at ${logicalPath}: ${stats.mode}`);
  }
}

function equalEntry(left: TreeEntry | undefined, right: TreeEntry | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  if (left.kind === "file") {
    return right.kind === "file" && left.text === right.text;
  }
  return right.kind === "symlink" && left.target === right.target;
}

function changeStatus(
  before: TreeEntry | undefined,
  after: TreeEntry | undefined,
): TestFileDiffStatus {
  if (before === undefined) {
    return "added";
  }
  return after === undefined ? "removed" : "modified";
}

function entryText(entry: TreeEntry | undefined): string {
  if (entry === undefined) {
    return "";
  }
  return entry.kind === "file" ? entry.text : `symlink -> ${entry.target}\n`;
}

function toPortablePath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}
