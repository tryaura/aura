import { describe, expect, it } from "vitest";

import { findProjectRoot } from "./project-root.js";
import { createMemoryReader, DIRECTORY } from "./testing.js";

describe("findProjectRoot", () => {
  it("walks up to the directory holding a .git directory", async () => {
    const reader = createMemoryReader({ "/home/dev/repo/.git": DIRECTORY });

    await expect(findProjectRoot("/home/dev/repo/packages/core", reader)).resolves.toBe(
      "/home/dev/repo",
    );
  });

  it("accepts the .git file a worktree leaves behind", async () => {
    const reader = createMemoryReader({ "/home/dev/tree/.git": "gitdir: /home/dev/repo/.git" });

    await expect(findProjectRoot("/home/dev/tree", reader)).resolves.toBe("/home/dev/tree");
  });

  it("stops at the filesystem root when nothing is found", async () => {
    const reader = createMemoryReader();

    await expect(findProjectRoot("/home/dev/elsewhere", reader)).resolves.toBeUndefined();
    expect(reader.reads).toEqual([
      "/home/dev/elsewhere/.git",
      "/home/dev/.git",
      "/home/.git",
      "/.git",
    ]);
  });
});
