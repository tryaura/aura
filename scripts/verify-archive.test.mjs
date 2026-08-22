import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { archiveEntries, verifyArchive } from "./verify-archive.mjs";

const BLOCK = 512;

describe("release archive verification", () => {
  it("accepts exactly the executable and its license", () => {
    expect(verifyArchive(tarGzip([entry("aura"), entry("LICENSE")]), ["aura", "LICENSE"])).toBe(
      undefined,
    );
  });

  /**
   * The case this exists for. bsdtar writes this sidecar for any file with an extended attribute,
   * and on macOS an executable reliably has one — so a runner image or a signing step is all it
   * takes to ship an archive no darwin user can install. `tar -t` merges it back and shows nothing.
   */
  it("refuses an AppleDouble sidecar macOS packaging can inject", () => {
    const archive = tarGzip([entry("._aura"), entry("aura"), entry("LICENSE")]);

    expect(verifyArchive(archive, ["aura", "LICENSE"])).toBe(
      "contains [._aura, LICENSE, aura], expected [LICENSE, aura]",
    );
  });

  it.each([
    { label: "a directory", typeflag: "5" },
    { label: "a symlink", typeflag: "2" },
    { label: "a pax extension record", typeflag: "x" },
  ])("refuses $label the extractor would reject", ({ typeflag }) => {
    const archive = tarGzip([entry("aura", { typeflag }), entry("LICENSE")]);

    expect(verifyArchive(archive, ["aura", "LICENSE"])).toContain("with type flag");
  });

  it("refuses an archive missing a target the release promised", () => {
    expect(verifyArchive(tarGzip([entry("aura")]), ["aura", "LICENSE"])).toBe(
      "contains [aura], expected [LICENSE, aura]",
    );
  });

  it("stops at the tar terminator rather than reading past it", () => {
    expect(archiveEntries(tarGzip([entry("aura")]))).toEqual({ names: ["aura"] });
  });
});

function entry(name, options = {}) {
  const content = Buffer.from(options.content ?? "bytes\n", "utf8");
  const block = Buffer.alloc(BLOCK, 0);
  block.write(name.slice(0, 100), 0, "utf8");
  block.write(octal(0o644, 7), 100, "utf8");
  block.write(octal(0, 7), 108, "utf8");
  block.write(octal(0, 7), 116, "utf8");
  block.write(octal(content.byteLength, 11), 124, "utf8");
  block.write(octal(0, 11), 136, "utf8");
  block.write(options.typeflag ?? "0", 156, "utf8");
  block.write("ustar\u000000", 257, "utf8");
  block.write("        ", 148, "utf8");
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  block.write(`${sum.toString(8).padStart(6, "0")}\u0000 `, 148, "utf8");
  const padding = Buffer.alloc((BLOCK - (content.byteLength % BLOCK)) % BLOCK);
  return Buffer.concat([block, content, padding]);
}

function tarGzip(blocks) {
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(BLOCK), Buffer.alloc(BLOCK)]));
}

function octal(value, width) {
  return `${value.toString(8).padStart(width, "0")}\0`;
}
