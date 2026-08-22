import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { extractArchive, type ArchiveFailure } from "./archive.js";
import { tarGzip, type TarFixtureEntry } from "./tar-fixture.js";

const EXECUTABLE = "acme";

describe("release archive extraction", () => {
  it("extracts exactly the executable and its license", async () => {
    const directory = await scratch();
    const failure = await extract(directory, [
      { content: "#!/bin/sh\necho 1.4.0\n", name: EXECUTABLE },
      { content: "Apache-2.0\n", name: "LICENSE" },
    ]);

    expect(failure).toBeUndefined();
    expect(await readFile(join(directory, "staged"), "utf8")).toBe("#!/bin/sh\necho 1.4.0\n");
    expect(await readFile(join(directory, "license"), "utf8")).toBe("Apache-2.0\n");
  });

  /**
   * The executable is not "extracted" because a header announced it — a stream that stops halfway
   * through the body leaves a partial file, and reporting that as the required entry hands the
   * caller a truncated program to go and verify.
   */
  it("reports an executable whose body never finished arriving", async () => {
    const directory = await scratch();
    const archive = join(directory, "archive.tar.gz");
    const whole = tarGzip([{ content: "x".repeat(2_000), name: EXECUTABLE }]);
    await writeFile(archive, gzipSync(gunzipSync(whole).subarray(0, 512 + 800)));

    expect(
      await extractArchive({
        archivePath: archive,
        entries: { [EXECUTABLE]: join(directory, "staged") },
        maxBytes: 1_024 * 1_024,
        requiredEntry: EXECUTABLE,
      }),
    ).toBe("missing-executable");
  });

  it("reports an archive that never carried the executable", async () => {
    const directory = await scratch();
    expect(await extract(directory, [{ content: "Apache-2.0\n", name: "LICENSE" }])).toBe(
      "missing-executable",
    );
  });

  /**
   * Every one of these is a way to write outside the two paths the caller named, or to slip a
   * second program past the version check. The extractor allow-lists entry names, so each is
   * refused on the header rather than after the bytes have landed somewhere.
   */
  it.each([
    { entry: { name: "/etc/cron.d/acme" }, label: "an absolute path" },
    { entry: { name: "../../.ssh/authorized_keys" }, label: "parent traversal" },
    { entry: { linkName: "/etc/passwd", name: EXECUTABLE, typeflag: "2" }, label: "a symlink" },
    { entry: { linkName: EXECUTABLE, name: "LICENSE", typeflag: "1" }, label: "a hard link" },
    { entry: { name: "payload.sh" }, label: "an unexpected file" },
    { entry: { name: "nested/", typeflag: "5" }, label: "a directory" },
    { entry: { name: "./PaxHeaders/acme", typeflag: "x" }, label: "a pax extension record" },
  ])("refuses $label", async ({ entry }) => {
    const directory = await scratch();
    const failure = await extract(directory, [{ content: "ok\n", name: EXECUTABLE }, entry]);
    expect(failure).toBe("unexpected-entry");
  });

  it("refuses a second copy of the executable", async () => {
    const directory = await scratch();
    const failure = await extract(directory, [
      { content: "first\n", name: EXECUTABLE },
      { content: "second\n", name: EXECUTABLE },
    ]);
    expect(failure).toBe("unexpected-entry");
  });

  it("refuses more extracted bytes than the bound allows", async () => {
    const directory = await scratch();
    const archive = join(directory, "archive.tar.gz");
    await writeFile(archive, tarGzip([{ content: "x".repeat(4_096), name: EXECUTABLE }]));

    const failure = await extractArchive({
      archivePath: archive,
      entries: { LICENSE: join(directory, "license"), [EXECUTABLE]: join(directory, "staged") },
      maxBytes: 1_024,
      requiredEntry: EXECUTABLE,
    });
    expect(failure).toBe("too-large");
  });

  it("refuses a stream that is not a readable gzip tar", async () => {
    const directory = await scratch();
    const archive = join(directory, "archive.tar.gz");
    await writeFile(archive, Buffer.from("not a gzip archive"));

    const failure = await extractArchive({
      archivePath: archive,
      entries: { [EXECUTABLE]: join(directory, "staged") },
      maxBytes: 4_096,
      requiredEntry: EXECUTABLE,
    });
    expect(failure).toBe("unreadable-archive");
  });

  it("stops decompressing once the tar terminator is complete", async () => {
    const directory = await scratch();
    const archive = join(directory, "archive.tar.gz");
    const release = tarGzip([{ content: "ok\n", name: EXECUTABLE }]);
    const compressedTrailer = gzipSync(Buffer.alloc(4 * 1_024 * 1_024, 1));
    await writeFile(archive, Buffer.concat([release, compressedTrailer]));

    expect(
      await extractArchive({
        archivePath: archive,
        entries: { [EXECUTABLE]: join(directory, "staged") },
        maxBytes: 1_024,
        requiredEntry: EXECUTABLE,
      }),
    ).toBeUndefined();
    expect(await readFile(join(directory, "staged"), "utf8")).toBe("ok\n");
  });
});

async function extract(
  directory: string,
  entries: readonly TarFixtureEntry[],
): Promise<ArchiveFailure | undefined> {
  const archive = join(directory, "archive.tar.gz");
  await writeFile(archive, tarGzip(entries));
  return await extractArchive({
    archivePath: archive,
    entries: { LICENSE: join(directory, "license"), [EXECUTABLE]: join(directory, "staged") },
    maxBytes: 1_000_000,
    requiredEntry: EXECUTABLE,
  });
}

function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "aura-update-archive-"));
}
