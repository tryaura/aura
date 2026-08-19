import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NODE_MUTATION_FILE_SYSTEM } from "./filesystem.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

// `O_NOFOLLOW` is POSIX-only, and Windows has no permission bits for a swapped link to capture.
describe.skipIf(process.platform === "win32")("chmodNoFollow", () => {
  it("changes the mode of the file at the path", async () => {
    const directory = await createDirectory();
    const path = join(directory, "config.json");
    await writeFile(path, "{}\n", "utf8");
    await chmod(path, 0o644);

    await NODE_MUTATION_FILE_SYSTEM.chmodNoFollow(path, 0o600);

    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  it("refuses a symbolic link instead of changing what it points at", async () => {
    const directory = await createDirectory();
    const target = join(directory, "target.json");
    const link = join(directory, "link.json");
    await writeFile(target, "{}\n", "utf8");
    await chmod(target, 0o644);
    await symlink(target, link);

    // The whole reason this call exists: a link planted between the check and the write must not
    // decide which file gets the mode.
    await expect(NODE_MUTATION_FILE_SYSTEM.chmodNoFollow(link, 0o600)).rejects.toHaveProperty(
      "code",
      "ELOOP",
    );
    expect((await lstat(target)).mode & 0o777).toBe(0o644);
  });
});

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aura-filesystem-"));
  temporaryDirectories.push(directory);
  return directory;
}
