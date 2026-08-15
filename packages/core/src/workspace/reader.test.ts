import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileReader, type FileReader, type PathContents } from "../index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("createFileReader", () => {
  it("reads a file's contents", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "CLAUDE.md");
    await writeFile(path, "# instructions\n", "utf8");

    await expect(read(path)).resolves.toEqual({
      content: "# instructions\n",
      exists: true,
      isDirectory: false,
    });
  });

  it("reports a directory as present without reading it", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "skills");
    await mkdir(path);

    await expect(read(path)).resolves.toEqual({ exists: true, isDirectory: true });
  });

  it("reports a missing path rather than throwing", async () => {
    const root = await createTemporaryDirectory();

    await expect(read(join(root, "absent.json"))).resolves.toEqual({
      exists: false,
      isDirectory: false,
    });
  });

  it("treats a dangling symlink as missing", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "AGENTS.md");
    await symlink(join(root, "gone.md"), path);

    await expect(read(path)).resolves.toEqual({ exists: false, isDirectory: false });
  });
});

const reader: FileReader = createFileReader();

function read(path: string): Promise<PathContents> {
  return reader.read(path);
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aura-reader-"));
  temporaryDirectories.push(directory);
  return directory;
}
