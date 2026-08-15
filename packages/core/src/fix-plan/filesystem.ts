import type { Buffer } from "node:buffer";
import { chmod, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

let temporarySequence = 0;

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
): Promise<void> {
  const temporary = temporaryPathFor(path);
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });

  try {
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Puts a symbolic link at `path` the same way, for the same reasons. */
export async function replaceLink(path: string, target: string): Promise<void> {
  const temporary = temporaryPathFor(path);
  await symlink(target, temporary);

  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Removes only directories Aura created, refusing to erase new user content. */
export async function removeCreatedDirectories(created: string, deepest: string): Promise<void> {
  let current = deepest;
  while (true) {
    await rmdir(current);
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
