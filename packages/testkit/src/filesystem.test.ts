import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { captureFilesystem, diffFilesystem } from "./filesystem.js";
import { createSeedBuilder } from "./seed.js";

const IDENTITY = (value: string): string => value;

describe("filesystem diffs", () => {
  it("captures sorted, normalized text and symlink changes", async () => {
    await using seed = await createSeedBuilder()
      .homeFile("removed.txt", "remove me\n")
      .workspaceFile("changed.txt", "before\n")
      .build();

    const before = await captureFilesystem(seed);
    await writeFile(join(seed.homeDir, "added.txt"), "added\n", "utf8");
    await rm(join(seed.homeDir, "removed.txt"));
    await writeFile(join(seed.workspaceDir, "changed.txt"), "after\n", "utf8");
    await symlink(seed.homeDir, join(seed.workspaceDir, "home-link"));
    const after = await captureFilesystem(seed);

    const diffs = diffFilesystem(before, after, (value) =>
      value.replaceAll(seed.homeDir, "<HOME>"),
    );

    expect(diffs.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: "<HOME>/added.txt", status: "added" },
      { path: "<HOME>/removed.txt", status: "removed" },
      { path: "<WORKSPACE>/changed.txt", status: "modified" },
      { path: "<WORKSPACE>/home-link", status: "added" },
    ]);
    expect(diffs.map((diff) => diff.patch)).toMatchInlineSnapshot(`
      [
        "===================================================================
      --- /dev/null	before
      +++ <HOME>/added.txt	after
      @@ -0,0 +1,2 @@
      +mode 644
      +added
      ",
        "===================================================================
      --- <HOME>/removed.txt	before
      +++ /dev/null	after
      @@ -1,2 +0,0 @@
      -mode 644
      -remove me
      ",
        "Index: <WORKSPACE>/changed.txt
      ===================================================================
      --- <WORKSPACE>/changed.txt	before
      +++ <WORKSPACE>/changed.txt	after
      @@ -1,2 +1,2 @@
       mode 644
      -before
      +after
      ",
        "===================================================================
      --- /dev/null	before
      +++ <WORKSPACE>/home-link	after
      @@ -0,0 +1,1 @@
      +symlink -> <HOME>
      ",
      ]
    `);
    expect(diffs.every((diff) => !diff.patch.includes(seed.homeDir))).toBe(true);
  });

  it("reports a permission change that leaves content alone", async () => {
    await using seed = await createSeedBuilder().homeFile("config.json", "{}\n").build();
    const path = join(seed.homeDir, "config.json");
    await chmod(path, 0o644);

    const before = await captureFilesystem(seed);
    await chmod(path, 0o600);
    const diffs = diffFilesystem(before, await captureFilesystem(seed), IDENTITY);

    expect(diffs.map(({ path: changed, status }) => ({ path: changed, status }))).toEqual([
      { path: "<HOME>/config.json", status: "modified" },
    ]);
    expect(diffs[0]?.patch).toContain("-mode 644");
    expect(diffs[0]?.patch).toContain("+mode 600");
  });

  it("reports a directory that was created empty", async () => {
    await using seed = await createSeedBuilder().homeFile("keep.txt", "keep\n").build();

    const before = await captureFilesystem(seed);
    await mkdir(join(seed.homeDir, ".config", "tool"), { recursive: true });
    const diffs = diffFilesystem(before, await captureFilesystem(seed), IDENTITY);

    expect(diffs.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: "<HOME>/.config", status: "added" },
      { path: "<HOME>/.config/tool", status: "added" },
    ]);
    expect(diffs[0]?.patch).toContain("+directory");
  });

  it("records binary content by shape instead of mangling it as text", async () => {
    await using seed = await createSeedBuilder().homeFile("keep.txt", "keep\n").build();
    const path = join(seed.homeDir, "cache.bin");
    await writeFile(path, Buffer.from([0x00, 0x01, 0xff, 0xfe]));

    const before = await captureFilesystem(seed);
    await writeFile(path, Buffer.from([0x00, 0x01, 0xff, 0x00]));
    const diffs = diffFilesystem(before, await captureFilesystem(seed), IDENTITY);

    expect(diffs.map(({ path: changed, status }) => ({ path: changed, status }))).toEqual([
      { path: "<HOME>/cache.bin", status: "modified" },
    ]);
    expect(diffs[0]?.patch).toContain("binary 4 bytes sha256:");
    expect(diffs[0]?.patch).not.toContain("�");
  });
});
