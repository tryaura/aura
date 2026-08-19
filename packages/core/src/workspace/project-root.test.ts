import { describe, expect, it } from "vitest";

import { findGitMainWorktreeRoot, findProjectRoot } from "./project-root.js";
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

describe("findGitMainWorktreeRoot", () => {
  it("uses the repository root for a normal checkout", async () => {
    const reader = createMemoryReader({ "/home/dev/repo/.git": DIRECTORY });

    await expect(findGitMainWorktreeRoot("/home/dev/repo", reader)).resolves.toBe("/home/dev/repo");
  });

  it.each([
    ["gitdir: /home/dev/repo/.git/worktrees/tree\n", "/home/dev/repo"],
    ["gitdir: ../repo/.git/worktrees/tree\n", "/home/dev/repo"],
  ])("resolves a linked worktree pointer", async (content, expected) => {
    const reader = createMemoryReader({ "/home/dev/tree/.git": content });

    await expect(findGitMainWorktreeRoot("/home/dev/tree", reader)).resolves.toBe(expected);
  });

  it.each([
    ["missing marker", createMemoryReader()],
    ["empty pointer", createMemoryReader({ "/home/dev/tree/.git": "gitdir:   \n" })],
    ["malformed pointer", createMemoryReader({ "/home/dev/tree/.git": "not a pointer\n" })],
    [
      "unexpected layout",
      createMemoryReader({ "/home/dev/tree/.git": "gitdir: /home/dev/repo/.git/tree\n" }),
    ],
    [
      "unreadable marker",
      createMemoryReader(
        { "/home/dev/tree/.git": "gitdir: /home/dev/repo/.git/worktrees/tree\n" },
        { problems: { "/home/dev/tree/.git": "denied" } },
      ),
    ],
  ])("returns undefined for a %s", async (_case, reader) => {
    await expect(findGitMainWorktreeRoot("/home/dev/tree", reader)).resolves.toBeUndefined();
  });
});
