import { gzipSync } from "node:zlib";

import { TAR_BLOCK_BYTES } from "./tar-header.js";

/** One entry a fixture archive should contain, including shapes the extractor must refuse. */
export interface TarFixtureEntry {
  readonly content?: string | undefined;
  /** Target of a link entry, written into the header's linkname field. */
  readonly linkName?: string | undefined;
  readonly name: string;
  /** Added to the computed header checksum, so a case can produce one that does not verify. */
  readonly checksumOffset?: number | undefined;
  /** ustar `prefix`, which a reader must join to `name` to recover the whole path. */
  readonly prefix?: string | undefined;
  /** ustar type flag. `0` is a regular file, `2` a symlink, `5` a directory. */
  readonly typeflag?: string | undefined;
}

/**
 * Builds a gzipped tar in memory.
 *
 * Written by hand rather than shelled out to `tar` so a test can produce archives no packaging
 * tool would willingly create — an absolute path, a symlink, a duplicated entry — which are
 * exactly the shapes the extractor exists to refuse.
 */
export function tarGzip(entries: readonly TarFixtureEntry[]): Buffer {
  const blocks = entries.flatMap((entry) => {
    const content = Buffer.from(entry.content ?? "", "utf8");
    return [header(entry, content.byteLength), content, padding(content.byteLength)];
  });
  return gzipSync(
    Buffer.concat([...blocks, Buffer.alloc(TAR_BLOCK_BYTES), Buffer.alloc(TAR_BLOCK_BYTES)]),
  );
}

function header(entry: TarFixtureEntry, size: number): Buffer {
  const block = Buffer.alloc(TAR_BLOCK_BYTES, 0);
  block.write(entry.name.slice(0, 100), 0, "utf8");
  block.write(octal(0o644, 7), 100, "utf8");
  block.write(octal(0, 7), 108, "utf8");
  block.write(octal(0, 7), 116, "utf8");
  block.write(octal(size, 11), 124, "utf8");
  block.write(octal(0, 11), 136, "utf8");
  block.write(entry.typeflag ?? "0", 156, "utf8");
  block.write((entry.linkName ?? "").slice(0, 100), 157, "utf8");
  block.write("ustar\u000000", 257, "utf8");
  block.write((entry.prefix ?? "").slice(0, 155), 345, "utf8");
  block.write("        ", 148, "utf8");
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  const checksum = sum + (entry.checksumOffset ?? 0);
  block.write(`${checksum.toString(8).padStart(6, "0")}\u0000 `, 148, "utf8");
  return block;
}

function padding(size: number): Buffer {
  return Buffer.alloc((TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES);
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width, "0")}\0`;
}
