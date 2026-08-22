#!/usr/bin/env node
/* eslint-disable no-restricted-properties -- archive verification owns its process boundary */
/**
 * Asserts a release archive contains exactly the entries the startup updater will accept.
 *
 * The updater's extractor allow-lists entries by name and refuses every other tar shape — a
 * directory, a symlink, a PAX record, an AppleDouble sidecar. That strictness is the point, and it
 * means a packaging step which quietly adds an entry produces an archive nobody can install, on a
 * platform nobody is testing, discovered only once the release is already immutable.
 *
 * `tar` is where that happens. bsdtar writes a `._name` AppleDouble sidecar for any file carrying
 * an extended attribute, and on macOS an executable reliably carries one, so a runner image or a
 * signing step is all it takes. This reads the archive the way the updater does rather than the way
 * `tar -t` does, which merges those sidecars back in and shows nothing.
 *
 * Usage: node scripts/verify-archive.mjs <archive.tar.gz> <entry> [entry...]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const BLOCK = 512;
const NAME = { length: 100, offset: 0 };
const SIZE = { length: 12, offset: 124 };
const TYPEFLAG_OFFSET = 156;

/** Type flags for a plain file. `0` is ustar; NUL is the historic spelling of the same thing. */
const REGULAR_TYPES = new Set(["0", "\0"]);

/**
 * The sorted entry names of a gzipped tar, or the reason it is not one this updater can extract.
 *
 * Returns rather than throws so the caller owns how a refusal is reported, and so a test can name
 * the shape that was refused instead of matching on process output.
 */
export function archiveEntries(gzipped) {
  const tar = gunzipSync(gzipped);
  const names = [];
  let offset = 0;
  while (offset + BLOCK <= tar.byteLength) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) {
      break;
    }
    const entry = header(block);
    if (entry.problem !== undefined) {
      return { problem: entry.problem };
    }
    names.push(entry.name);
    offset += BLOCK + Math.ceil(entry.size / BLOCK) * BLOCK;
  }
  return { names: names.sort() };
}

/** Whether an archive is exactly the expected set, with the mismatch named when it is not. */
export function verifyArchive(gzipped, expected) {
  const read = archiveEntries(gzipped);
  if (read.problem !== undefined) {
    return read.problem;
  }
  const actual = read.names.join(", ");
  const wanted = [...expected].sort().join(", ");
  return actual === wanted ? undefined : `contains [${actual}], expected [${wanted}]`;
}

/** One header block: a plain-file entry, or the shape the extractor would have refused. */
function header(block) {
  const name = text(block, NAME);
  const type = String.fromCharCode(block[TYPEFLAG_OFFSET] ?? 0);
  if (!REGULAR_TYPES.has(type)) {
    return { problem: `carries ${JSON.stringify(name)} with type flag ${JSON.stringify(type)}` };
  }
  const size = entrySize(block);
  return size === undefined
    ? { problem: `carries ${JSON.stringify(name)} with an unreadable size` }
    : { name, size };
}

/** The declared entry length, which is what advances the read to the next header. */
function entrySize(block) {
  const value = Number.parseInt(text(block, SIZE).trim() || "0", 8);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function text(block, field) {
  const bytes = block.subarray(field.offset, field.offset + field.length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}

function main() {
  const [archivePath, ...expected] = process.argv.slice(2);
  if (archivePath === undefined || expected.length === 0) {
    process.stderr.write("usage: verify-archive.mjs <archive.tar.gz> <entry> [entry...]\n");
    process.exitCode = 1;
    return;
  }
  const problem = verifyArchive(readFileSync(archivePath), expected);
  if (problem !== undefined) {
    process.stderr.write(`::error::${archivePath} ${problem}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${archivePath}: [${[...expected].sort().join(", ")}]\n`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main();
}
