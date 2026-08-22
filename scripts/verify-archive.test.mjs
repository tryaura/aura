import { describe, expect, it } from "vitest";

import { tarGzip } from "../packages/cli/src/update/tar-fixture.ts";
import { archiveEntries, verifyArchive } from "./verify-archive.mjs";

/**
 * Built with the extractor suites' own fixture, not a second copy of it. Two hand-written tar
 * writers is how a gate ends up asserting against archives the updater would never see.
 */
const REFUSED = "in a header the updater's extractor refuses";

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

    expect(verifyArchive(archive, ["aura", "LICENSE"])).toContain(REFUSED);
  });

  /**
   * The extractor joins `prefix` to `name` and then allow-lists the result, so a gate reading only
   * `name` would pass an archive that installs nowhere.
   */
  it("reads the ustar prefix the extractor joins", () => {
    const archive = tarGzip([entry("aura", { prefix: "dist" }), entry("LICENSE")]);

    expect(verifyArchive(archive, ["aura", "LICENSE"])).toBe(
      "contains [LICENSE, dist/aura], expected [LICENSE, aura]",
    );
  });

  /** The extractor verifies the header checksum, which is how it notices block misalignment. */
  it("refuses a header the extractor would not checksum", () => {
    const archive = tarGzip([entry("aura", { checksumOffset: 1 }), entry("LICENSE")]);

    expect(verifyArchive(archive, ["aura", "LICENSE"])).toContain(REFUSED);
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
  return { content: "bytes\n", name, ...options };
}
