import { rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { captureFilesystem, diffFilesystem } from "./filesystem.js";
import { createSeedBuilder } from "./seed.js";

describe("filesystem diffs", () => {
  it("captures sorted, normalized text and symlink changes", async () => {
    const seed = await createSeedBuilder()
      .homeFile("removed.txt", "remove me\n")
      .workspaceFile("changed.txt", "before\n")
      .build();

    try {
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
  "===================================================================\n--- /dev/null\tbefore\n+++ <HOME>/added.txt\tafter\n@@ -0,0 +1,1 @@\n+added\n",
  "===================================================================\n--- <HOME>/removed.txt\tbefore\n+++ /dev/null\tafter\n@@ -1,1 +0,0 @@\n-remove me\n",
  "Index: <WORKSPACE>/changed.txt\n===================================================================\n--- <WORKSPACE>/changed.txt\tbefore\n+++ <WORKSPACE>/changed.txt\tafter\n@@ -1,1 +1,1 @@\n-before\n+after\n",
  "===================================================================\n--- /dev/null\tbefore\n+++ <WORKSPACE>/home-link\tafter\n@@ -0,0 +1,1 @@\n+symlink -> <HOME>\n",
]
`);
      expect(diffs.every((diff) => !diff.patch.includes(seed.homeDir))).toBe(true);
    } finally {
      await seed.cleanup();
    }
  });
});
