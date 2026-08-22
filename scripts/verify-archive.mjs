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
 * "The way the updater does" is literal: the header parser below is imported from the extractor
 * itself, not reimplemented. A second copy of those rules is a gate that drifts, and a gate that
 * drifts passes an archive the updater refuses — permanently, because a published release is
 * immutable and its assets cannot be corrected in place. Node strips the types on import.
 *
 * Usage: node scripts/verify-archive.mjs <archive.tar.gz> <entry> [entry...]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import {
  isZeroBlock,
  parseTarHeader,
  TAR_BLOCK_BYTES,
} from "../packages/cli/src/update/tar-header.ts";

/** Header field read for diagnostics only. Nothing here decides whether an entry is acceptable. */
const NAME = { length: 100, offset: 0 };
const TYPEFLAG_OFFSET = 156;

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
  while (offset + TAR_BLOCK_BYTES <= tar.byteLength) {
    const block = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (isZeroBlock(block)) {
      break;
    }
    const entry = parseTarHeader(block);
    if (entry === undefined) {
      return { problem: refusal(block) };
    }
    names.push(entry.name);
    offset += TAR_BLOCK_BYTES + Math.ceil(entry.size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
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

/**
 * What to print about a header the extractor refused.
 *
 * The extractor itself refuses without saying why — deliberately, so nobody relaxes one case later
 * — which leaves the two fields worth showing a release engineer: what the entry called itself, and
 * the type flag that is the usual culprit. Neither is consulted to reach the verdict.
 */
function refusal(block) {
  const bytes = block.subarray(NAME.offset, NAME.offset + NAME.length);
  const end = bytes.indexOf(0);
  const name = bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
  const type = String.fromCharCode(block[TYPEFLAG_OFFSET] ?? 0);
  return `carries ${JSON.stringify(name)} with type flag ${JSON.stringify(type)}, in a header the updater's extractor refuses`;
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
