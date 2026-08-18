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
});
