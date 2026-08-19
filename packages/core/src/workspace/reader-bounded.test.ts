import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCachingReader, createFileReader, type FileReader } from "./reader.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("bounded reads", () => {
  it("reads whole files and prefixes from identity-verified handles", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "AGENTS.md");
    await writeFile(path, "abcdef", "utf8");
    await chmod(path, 0o644);
    const boundary = await canonical(root);

    await expect(reader.readWithin(path, [boundary])).resolves.toMatchObject({
      contents: { content: "abcdef", exists: true, isDirectory: false, pathKind: "file" },
      kind: "read",
      resolvedPath: await reader.realPath(path),
    });
    await expect(reader.readWithin(path, [boundary], { maxBytes: 3 })).resolves.toMatchObject({
      contents: { content: "abc", exists: true, isDirectory: false, size: 6 },
      kind: "read",
      resolvedPath: await reader.realPath(path),
    });
  });

  it("reports a missing path as absent rather than out of bounds", async () => {
    const root = await createTemporaryDirectory();
    const boundary = await canonical(root);

    await expect(reader.readWithin(join(root, "absent.md"), [boundary])).resolves.toEqual({
      contents: { exists: false, isDirectory: false },
      kind: "read",
    });
  });

  it("rejects a symlink swapped after an earlier canonicalization", async () => {
    const root = await createTemporaryDirectory();
    const project = join(root, "project");
    const safe = join(project, "safe.md");
    const secret = join(root, "secret.md");
    const link = join(project, "AGENTS.md");
    await mkdir(project);
    await writeFile(safe, "# safe", "utf8");
    await writeFile(secret, "secret", "utf8");
    await symlink(safe, link);
    const boundary = await canonical(project);

    const caching = createCachingReader(createFileReader());
    await expect(caching.realPath(link)).resolves.toBe(await reader.realPath(safe));
    await rm(link);
    await symlink(secret, link);

    const bounded = await caching.readWithin(link, [boundary]);

    expect(bounded).toMatchObject({
      contents: { problem: "outside-project" },
      kind: "outside",
      resolvedPath: await reader.realPath(secret),
    });
    expect(bounded.contents).not.toHaveProperty("content");
  });

  it("refuses an out-of-bounds target without opening it", async () => {
    const root = await createTemporaryDirectory();
    const project = join(root, "project");
    const secret = join(root, "credentials.json");
    const link = join(project, ".mcp.json");
    await mkdir(project);
    await writeFile(secret, "{}", "utf8");
    await chmod(secret, 0o000);
    await symlink(secret, link);
    const boundary = await canonical(project);

    // The mode is what makes this observable rather than a restatement of the test above: a reader
    // that opened first and asked about the boundary afterwards would report `denied` here, having
    // already touched a path it had no business touching. Under root the open would succeed and the
    // verdict would still be `outside-project`, so only the failure mode differs by privilege.
    await expect(reader.readWithin(link, [boundary])).resolves.toMatchObject({
      contents: { problem: "outside-project" },
      kind: "outside",
      resolvedPath: await reader.realPath(secret),
    });
  });

  it("memoizes a bounded identity check and read as one result", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "CLAUDE.md");
    await writeFile(path, "# first", "utf8");
    const boundary = await canonical(root);

    const caching = createCachingReader(createFileReader());
    const first = await caching.readWithin(path, [boundary]);
    await writeFile(path, "# second", "utf8");

    await expect(caching.readWithin(path, [boundary])).resolves.toEqual(first);
    expect(first.contents.content).toBe("# first");
  });
});

const reader: FileReader = createFileReader();

/** A boundary has to be canonical to match what a read resolves to; macOS temporaries are not. */
async function canonical(path: string): Promise<string> {
  const resolved = await reader.realPath(path);
  if (resolved === undefined) {
    throw new Error(`${path} must have a canonical path.`);
  }
  return resolved;
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aura-bounded-"));
  temporaryDirectories.push(directory);
  return directory;
}
