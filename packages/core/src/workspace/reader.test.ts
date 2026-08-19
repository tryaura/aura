import { exec } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createFileReader, MAX_FILE_BYTES, type FileReader, type PathContents } from "../index.js";
import { createCachingReader } from "./reader.js";

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
    await chmod(path, 0o644);

    await expect(read(path)).resolves.toEqual({
      content: "# instructions\n",
      exists: true,
      isDirectory: false,
      mode: 0o644,
      pathKind: "file",
    });
  });

  it("inspects a file without capturing its contents", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "AGENTS.md");
    await writeFile(path, "# instructions\n", "utf8");
    await chmod(path, 0o600);
    const inspect = reader.inspect;
    if (inspect === undefined) {
      throw new Error("The production reader must support metadata-only inspection.");
    }

    await expect(inspect(path)).resolves.toEqual({
      exists: true,
      isDirectory: false,
      mode: 0o600,
      pathKind: "file",
      size: 15,
    });
  });

  it("reads only the requested UTF-8 prefix", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "AGENTS.md");
    await writeFile(path, "abcdef", "utf8");
    await chmod(path, 0o644);

    await expect(reader.read(path, { maxBytes: 3 })).resolves.toEqual({
      content: "abc",
      exists: true,
      isDirectory: false,
      mode: 0o644,
      pathKind: "file",
      size: 6,
    });
  });

  it("reads whole files and prefixes from identity-verified handles", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "AGENTS.md");
    await writeFile(path, "abcdef", "utf8");
    await chmod(path, 0o644);
    const boundary = await reader.realPath(root);
    if (boundary === undefined) {
      throw new Error("The temporary directory must have a canonical path.");
    }

    await expect(reader.readWithin(path, [boundary])).resolves.toMatchObject({
      contents: { content: "abcdef", exists: true, isDirectory: false, pathKind: "file" },
      resolvedPath: await reader.realPath(path),
      withinBoundary: true,
    });
    await expect(reader.readWithin(path, [boundary], { maxBytes: 3 })).resolves.toMatchObject({
      contents: { content: "abc", exists: true, isDirectory: false, size: 6 },
      resolvedPath: await reader.realPath(path),
      withinBoundary: true,
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
    const boundary = await reader.realPath(project);
    if (boundary === undefined) {
      throw new Error("The project directory must have a canonical path.");
    }

    const caching = createCachingReader(createFileReader());
    await expect(caching.realPath(link)).resolves.toBe(await reader.realPath(safe));
    await rm(link);
    await symlink(secret, link);

    const bounded = await caching.readWithin(link, [boundary]);

    expect(bounded).toMatchObject({
      contents: { problem: "outside-project" },
      resolvedPath: await reader.realPath(secret),
      withinBoundary: false,
    });
    expect(bounded.contents).not.toHaveProperty("content");
  });

  it("lists a directory's immediate children, sorted", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "skills");
    await mkdir(join(path, "review"), { recursive: true });
    await mkdir(join(path, "audit"));
    await writeFile(join(path, "review", "SKILL.md"), "# review", "utf8");

    await expect(read(path)).resolves.toEqual({
      entries: ["audit", "review"],
      exists: true,
      isDirectory: true,
      pathKind: "directory",
    });
  });

  it("reports a missing path rather than throwing", async () => {
    const root = await createTemporaryDirectory();

    await expect(read(join(root, "absent.json"))).resolves.toEqual({
      exists: false,
      isDirectory: false,
    });
  });

  it("preserves a dangling symlink and its target", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "AGENTS.md");
    await symlink(join(root, "gone.md"), path);

    await expect(read(path)).resolves.toEqual({
      exists: true,
      isDirectory: false,
      pathKind: "symlink",
      symlinkTarget: join(root, "gone.md"),
    });
  });

  // Windows has no mkfifo; the isFile guard that makes this pass is platform-independent.
  it.skipIf(process.platform === "win32")(
    "refuses a named pipe instead of blocking on it forever",
    async () => {
      const root = await createTemporaryDirectory();
      const path = join(root, "config.json");
      await promisify(exec)(`mkfifo ${path}`);

      // Nothing will ever write to this pipe. Before the isFile check, readFile never returned.
      await expect(read(path)).resolves.toEqual({
        exists: true,
        isDirectory: false,
        problem: "unsupported",
      });
    },
  );

  it("refuses a file larger than the limit rather than truncating it", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "history.jsonl");
    await writeFile(path, "x".repeat(MAX_FILE_BYTES + 1), "utf8");
    await chmod(path, 0o644);

    await expect(read(path)).resolves.toEqual({
      exists: true,
      isDirectory: false,
      mode: 0o644,
      pathKind: "file",
      problem: "too-large",
    });
  });

  it("reports an unreadable file as unreadable rather than missing", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "credentials.json");
    await writeFile(path, "{}", "utf8");
    await chmod(path, 0o000);

    const contents = await read(path);

    // Running as root defeats the permission bits, so only assert when they took effect.
    if (contents.content === undefined) {
      expect(contents).toEqual({
        exists: true,
        isDirectory: false,
        mode: 0o000,
        pathKind: "file",
        problem: "denied",
      });
    }
  });

  it("resolves a symlink to its canonical target", async () => {
    const root = await createTemporaryDirectory();
    const target = join(root, "real.md");
    const link = join(root, "link.md");
    await writeFile(target, "# real", "utf8");
    await chmod(target, 0o644);
    await symlink(target, link);

    // The mode of the file the link resolves to, which is the file whose contents were read.
    await expect(read(link)).resolves.toEqual({
      content: "# real",
      exists: true,
      isDirectory: false,
      mode: 0o644,
      pathKind: "symlink",
      symlinkTarget: target,
    });
    await expect(reader.realPath(link)).resolves.toBe(await reader.realPath(target));
    await expect(reader.realPath(join(root, "gone.md"))).resolves.toBeUndefined();
  });

  it("keeps every read bounded when far more paths are requested than the limit allows", async () => {
    const root = await createTemporaryDirectory();
    const paths = Array.from({ length: 200 }, (_, index) => join(root, `file-${index}.md`));
    await Promise.all(paths.map((path, index) => writeFile(path, `# ${index}`, "utf8")));

    const contents = await Promise.all(paths.map((path) => read(path)));

    expect(contents.map((entry) => entry.content)).toEqual(paths.map((_, index) => `# ${index}`));
  });
});

describe("createCachingReader", () => {
  it("reads a path once and serves the same result after", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "CLAUDE.md");
    await writeFile(path, "# first", "utf8");

    const caching = createCachingReader(createFileReader());
    const first = await caching.read(path);
    await writeFile(path, "# second", "utf8");

    await expect(caching.read(path)).resolves.toEqual(first);
    expect(first.content).toBe("# first");
  });

  it("memoizes a bounded identity check and read as one result", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "CLAUDE.md");
    await writeFile(path, "# first", "utf8");
    const boundary = await reader.realPath(root);
    if (boundary === undefined) {
      throw new Error("The temporary directory must have a canonical path.");
    }

    const caching = createCachingReader(createFileReader());
    const first = await caching.readWithin(path, [boundary]);
    await writeFile(path, "# second", "utf8");

    await expect(caching.readWithin(path, [boundary])).resolves.toEqual(first);
    expect(first.contents.content).toBe("# first");
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
