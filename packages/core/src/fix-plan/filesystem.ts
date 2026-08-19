import type { Buffer } from "node:buffer";
import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

let temporarySequence = 0;

/**
 * `O_NOFOLLOW` where the platform defines it, and nothing where it does not.
 *
 * Only Windows lacks the flag, and Windows has no POSIX permission bits for a swapped link to
 * capture — its `chmod` toggles the read-only attribute and nothing else. The value is read through
 * an integer guard because `@types/node` declares the constant unconditionally.
 */
const NO_FOLLOW = Number.isInteger(constants.O_NOFOLLOW) ? constants.O_NOFOLLOW : 0;

interface WriteOptions {
  readonly encoding?: "utf8" | undefined;
  readonly flag: "wx";
  readonly mode: number;
}

/** The mutating filesystem calls the apply kernel uses, injectable for deterministic fault tests. */
export interface MutationFileSystem {
  readonly chmod: (path: string, mode: number) => Promise<void>;
  /**
   * Applies a mode to the path itself, refusing a final symbolic link.
   *
   * The only correct way to chmod a path Aura did not just create: plain `chmod` resolves the path
   * again and would follow a link swapped in since the check, which is exactly what every other
   * mutation here is shaped to avoid.
   */
  readonly chmodNoFollow: (path: string, mode: number) => Promise<void>;
  readonly mkdir: (
    path: string,
    options?: { readonly mode?: number | undefined; readonly recursive?: true | undefined },
  ) => Promise<string | undefined>;
  readonly rename: (source: string, destination: string) => Promise<void>;
  readonly rm: (path: string, options: { readonly force: true }) => Promise<void>;
  readonly rmdir: (path: string) => Promise<void>;
  readonly symlink: (target: string, path: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
  readonly utimes: (path: string, accessTime: number, modifiedTime: number) => Promise<void>;
  readonly writeFile: (
    path: string,
    content: Buffer | string,
    options: WriteOptions,
  ) => Promise<void>;
}

/** Production implementation of the mutation seam. */
export const NODE_MUTATION_FILE_SYSTEM: MutationFileSystem = {
  chmod: (path, mode) => chmod(path, mode),
  chmodNoFollow: async (path, mode) => {
    const handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
    try {
      // Through the handle, so the mode lands on the file the open accepted rather than on whatever
      // the path resolves to by the time it is applied.
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
  },
  mkdir: async (path, options) => {
    if (options?.recursive === true) {
      return mkdir(path, { mode: options.mode, recursive: true });
    }
    await mkdir(path, { mode: options?.mode });
    return undefined;
  },
  rename: (source, destination) => rename(source, destination),
  rm: (path, options) => rm(path, options),
  rmdir: (path) => rmdir(path),
  symlink: (target, path) => symlink(target, path),
  unlink: (path) => unlink(path),
  utimes: (path, accessTime, modifiedTime) => utimes(path, accessTime, modifiedTime),
  writeFile: (path, content, options) => writeFile(path, content, options),
};

/**
 * Replaces a path with new contents, atomically and without following a final symbolic link.
 *
 * Writing in place would do neither: it follows a symbolic link that took the path's place after the
 * check, and it truncates before it writes, so an interrupted write leaves a half-written file.
 * Building the replacement beside the target and renaming it over avoids both — `rename` replaces
 * the link itself, and is either fully done or not done at all.
 */
export async function replaceFile(
  path: string,
  content: Buffer | string,
  mode: number,
  filesystem: MutationFileSystem = NODE_MUTATION_FILE_SYSTEM,
): Promise<void> {
  const temporary = temporaryPathFor(path);
  await filesystem.writeFile(temporary, content, { flag: "wx", mode: 0o600 });

  try {
    await filesystem.chmod(temporary, mode);
    await filesystem.rename(temporary, path);
  } catch (error) {
    await filesystem.rm(temporary, { force: true });
    throw error;
  }
}

/** Puts a symbolic link at `path` the same way, for the same reasons. */
export async function replaceLink(
  path: string,
  target: string,
  filesystem: MutationFileSystem = NODE_MUTATION_FILE_SYSTEM,
): Promise<void> {
  const temporary = temporaryPathFor(path);
  await filesystem.symlink(target, temporary);

  try {
    await filesystem.rename(temporary, path);
  } catch (error) {
    await filesystem.rm(temporary, { force: true });
    throw error;
  }
}

/** Removes only directories Aura created, refusing to erase new user content. */
export async function removeCreatedDirectories(
  created: string,
  deepest: string,
  filesystem: MutationFileSystem = NODE_MUTATION_FILE_SYSTEM,
): Promise<void> {
  let current = deepest;
  while (true) {
    await filesystem.rmdir(current);
    if (current === created) {
      return;
    }
    current = dirname(current);
  }
}

function temporaryPathFor(target: string): string {
  temporarySequence += 1;
  return join(
    dirname(target),
    `.${basename(target)}.aura-${String(process.pid)}-${String(temporarySequence)}.tmp`,
  );
}
