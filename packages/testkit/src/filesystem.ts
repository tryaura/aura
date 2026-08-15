import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, relative, sep } from "node:path";

import { createTwoFilesPatch } from "diff";

import type { TestFileDiff, TestFileDiffStatus, TestSeed } from "./types.js";

interface DirectoryEntry {
  readonly kind: "directory";
  readonly mode: number;
}

interface FileEntry {
  readonly kind: "file";
  readonly mode: number;
  readonly text: string;
}

/** A file whose bytes are not UTF-8 text, recorded by shape so a change is still visible. */
interface BinaryEntry {
  readonly byteLength: number;
  readonly digest: string;
  readonly kind: "binary";
  readonly mode: number;
}

interface SymlinkEntry {
  readonly kind: "symlink";
  readonly target: string;
}

type TreeEntry = BinaryEntry | DirectoryEntry | FileEntry | SymlinkEntry;
export type FilesystemSnapshot = ReadonlyMap<string, TreeEntry>;

const NULL_PATH = "/dev/null";
const UTF8 = new TextDecoder("utf8", { fatal: true });

export async function captureFilesystem(seed: TestSeed): Promise<FilesystemSnapshot> {
  const entries = new Map<string, TreeEntry>();
  await Promise.all([
    captureDirectory(seed.homeDir, seed.homeDir, "<HOME>", entries),
    captureDirectory(seed.workspaceDir, seed.workspaceDir, "<WORKSPACE>", entries),
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
      normalize(renderEntry(previous)),
      normalize(renderEntry(current)),
      "before",
      "after",
      { context: 3 },
    );
    diffs.push(Object.freeze({ patch, path, status }));
  }

  return Object.freeze(diffs);
}

async function captureDirectory(
  root: string,
  directory: string,
  label: string,
  entries: Map<string, TreeEntry>,
): Promise<void> {
  const children = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    children.map((child) => captureChild(root, join(directory, child.name), child, label, entries)),
  );
}

async function captureChild(
  root: string,
  path: string,
  child: Dirent,
  label: string,
  entries: Map<string, TreeEntry>,
): Promise<void> {
  const logicalPath = `${label}/${toPortablePath(relative(root, path))}`;
  // Read before the recursion so a directory a fix created is visible even when it holds nothing:
  // an entry that exists only as a name is exactly the change a tree of files cannot express.
  if (child.isDirectory()) {
    entries.set(logicalPath, { kind: "directory", mode: await readMode(path) });
    await captureDirectory(root, path, label, entries);
    return;
  }
  if (child.isFile()) {
    entries.set(logicalPath, await readFileEntry(path));
    return;
  }
  if (child.isSymbolicLink()) {
    entries.set(logicalPath, { kind: "symlink", target: await readlink(path) });
    return;
  }

  throw new Error(`Cannot snapshot unsupported fixture entry at ${logicalPath}.`);
}

async function readFileEntry(path: string): Promise<BinaryEntry | FileEntry> {
  const [content, mode] = await Promise.all([readFile(path), readMode(path)]);
  const text = decodeText(content);
  if (text === undefined) {
    return {
      byteLength: content.byteLength,
      digest: createHash("sha256").update(content).digest("hex"),
      kind: "binary",
      mode,
    };
  }
  return { kind: "file", mode, text };
}

/** Bytes that are not UTF-8 text, and text holding NUL, cannot be rendered into a readable patch. */
function decodeText(content: Buffer): string | undefined {
  if (content.includes(0)) {
    return undefined;
  }
  try {
    return UTF8.decode(content);
  } catch {
    return undefined;
  }
}

async function readMode(path: string): Promise<number> {
  return (await lstat(path)).mode & 0o777;
}

function equalEntry(left: TreeEntry | undefined, right: TreeEntry | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return renderEntry(left) === renderEntry(right);
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

/**
 * Renders one entry as the text its patch diffs.
 *
 * Permission bits lead every entry that has them, which is what makes a `chmod` with no other
 * change show up as a diff at all.
 */
function renderEntry(entry: TreeEntry | undefined): string {
  if (entry === undefined) {
    return "";
  }
  if (entry.kind === "symlink") {
    return `symlink -> ${entry.target}\n`;
  }

  const header = `mode ${entry.mode.toString(8).padStart(3, "0")}\n`;
  if (entry.kind === "directory") {
    return `${header}directory\n`;
  }
  if (entry.kind === "binary") {
    return `${header}binary ${String(entry.byteLength)} bytes sha256:${entry.digest}\n`;
  }
  return `${header}${entry.text}`;
}

function toPortablePath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}
