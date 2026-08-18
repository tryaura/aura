import { afterEach, describe, expect, it, vi } from "vitest";

import { createFileReader } from "./reader.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("embedded asset directories", () => {
  it("synthesizes immediate directory entries from Bun's flat asset list", async () => {
    vi.stubGlobal("Bun", {
      embeddedFiles: [
        { name: "content/skills/review/SKILL.md" },
        { name: "content/skills/review/references/checklist.md" },
      ],
    });
    const reader = createFileReader();
    const root = "/$bunfs/root/content/skills/review";

    await expect(reader.read(root)).resolves.toEqual({
      entries: ["SKILL.md", "references"],
      exists: true,
      isDirectory: true,
      pathKind: "directory",
    });
    await expect(reader.read(`${root}/references`)).resolves.toEqual({
      entries: ["checklist.md"],
      exists: true,
      isDirectory: true,
      pathKind: "directory",
    });
    await expect(reader.exists(root)).resolves.toBe(true);
    await expect(reader.realPath(root)).resolves.toBe(root);
  });

  it("does not synthesize unrelated or empty directories", async () => {
    vi.stubGlobal("Bun", {
      embeddedFiles: [{ name: "content/skills/review/SKILL.md" }],
    });
    const reader = createFileReader();

    await expect(reader.read("/$bunfs/root/content/skills/audit")).resolves.toEqual({
      exists: false,
      isDirectory: false,
    });
    await expect(reader.read("/tmp/content/skills/review")).resolves.toEqual({
      exists: false,
      isDirectory: false,
    });
  });

  it("does not treat a sibling sharing a name prefix as a parent", async () => {
    vi.stubGlobal("Bun", {
      embeddedFiles: [{ name: "content/skills/review/SKILL.md" }],
    });
    const reader = createFileReader();

    await expect(reader.read("/$bunfs/root/content/skills/rev")).resolves.toEqual({
      exists: false,
      isDirectory: false,
    });
  });

  it("reaches the embedded root with and without its trailing slash", async () => {
    vi.stubGlobal("Bun", { embeddedFiles: [{ name: "content/snippets/engineering.md" }] });
    const reader = createFileReader();
    const entries = {
      entries: ["content"],
      exists: true,
      isDirectory: true,
      pathKind: "directory",
    };

    // `resolve` and `join` strip the trailing slash a directory URL carries, so both must answer.
    await expect(reader.read("/$bunfs/root/")).resolves.toEqual(entries);
    await expect(reader.read("/$bunfs/root")).resolves.toEqual(entries);
  });

  it("re-reads the index when the embedded file list changes", async () => {
    const reader = createFileReader();
    vi.stubGlobal("Bun", { embeddedFiles: [{ name: "content/a.md" }] });
    await expect(reader.read("/$bunfs/root/content")).resolves.toMatchObject({ entries: ["a.md"] });

    vi.stubGlobal("Bun", { embeddedFiles: [{ name: "content/b.md" }] });
    await expect(reader.read("/$bunfs/root/content")).resolves.toMatchObject({ entries: ["b.md"] });
  });
});
