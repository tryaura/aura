import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

import { readInvocations, validateShim, writeShim } from "./shims.js";
import type { ShimResponse, TestSeed, TestSeedBuilder } from "./types.js";

interface SeedFile {
  readonly content: string;
  readonly path: string;
}

interface SeedShim {
  readonly command: string;
  readonly responses: readonly ShimResponse[];
}

class SeedBuilder implements TestSeedBuilder {
  readonly #homeFiles = new Map<string, SeedFile>();
  readonly #shims = new Map<string, SeedShim>();
  readonly #workspaceFiles = new Map<string, SeedFile>();

  homeFile(path: string, content: string): TestSeedBuilder {
    addFile(this.#homeFiles, "HOME", path, content);
    return this;
  }

  shim(command: string, responses: readonly ShimResponse[]): TestSeedBuilder {
    validateShim(command, responses);
    if (this.#shims.has(command)) {
      throw new Error(`Shim command is already seeded: ${command}`);
    }
    this.#shims.set(command, {
      command,
      responses: responses.map((response) => ({ ...response, args: [...response.args] })),
    });
    return this;
  }

  workspaceFile(path: string, content: string): TestSeedBuilder {
    addFile(this.#workspaceFiles, "workspace", path, content);
    return this;
  }

  async build(): Promise<TestSeed> {
    // Canonicalized on purpose. `mkdtemp` hands back the uncanonicalized name — `/var/…` on macOS,
    // where the real path is `/private/var/…` — and any tool the run shells out to that resolves a
    // path reports the other spelling, which then survives normalization and lands a machine-local
    // absolute path in a committed snapshot.
    const root = await realpath(await mkdtemp(join(tmpdir(), "aura-testkit-")));
    const homeDir = join(root, "home");
    const logDir = join(root, "invocations");
    const pathDir = join(root, "bin");
    const workspaceDir = join(root, "workspace");
    const commands = new Set(this.#shims.keys());

    try {
      await Promise.all([
        mkdir(homeDir, { recursive: true }),
        mkdir(logDir, { recursive: true }),
        mkdir(pathDir, { recursive: true }),
        mkdir(workspaceDir, { recursive: true }),
      ]);
      await Promise.all([
        writeFiles(homeDir, this.#homeFiles.values()),
        writeFiles(workspaceDir, this.#workspaceFiles.values()),
      ]);
      await Promise.all(
        [...this.#shims.values()].map((shim) =>
          writeShim({ command: shim.command, logDir, pathDir, responses: shim.responses }),
        ),
      );
    } catch (error) {
      await rm(root, { force: true, recursive: true });
      throw error;
    }

    let cleanupPromise: Promise<void> | undefined;
    const cleanup = (): Promise<void> => {
      cleanupPromise ??= rm(root, { force: true, recursive: true });
      return cleanupPromise;
    };
    return Object.freeze({
      cleanup,
      homeDir,
      invocations: (command: string) =>
        commands.has(command) ? readInvocations(logDir, command) : Promise.resolve([]),
      pathDir,
      workspaceDir,
      [Symbol.asyncDispose]: cleanup,
    });
  }
}

/** Starts a fluent description of one isolated fake machine. */
export function createSeedBuilder(): TestSeedBuilder {
  return new SeedBuilder();
}

function addFile(files: Map<string, SeedFile>, scope: string, path: string, content: string): void {
  const normalized = normalizeSeedPath(path);
  if (files.has(normalized)) {
    throw new Error(`${scope} file is already seeded: ${normalized}`);
  }
  files.set(normalized, { content, path: normalized });
}

function normalizeSeedPath(path: string): string {
  if (path.length === 0 || path.includes("\0") || isAbsolute(path)) {
    throw new Error(`Seed file path must be a non-empty relative path. Received: ${path}`);
  }

  const normalized = normalize(path);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new Error(`Seed file path must stay inside its root. Received: ${path}`);
  }
  return normalized;
}

/**
 * Materializes one root's files.
 *
 * Sequential on purpose: two declared paths can disagree about whether a name is a file or a
 * directory, and writing them in declaration order makes which one fails deterministic.
 */
async function writeFiles(root: string, files: Iterable<SeedFile>): Promise<void> {
  for (const file of files) {
    const destination = join(root, file.path);
    const fromRoot = relative(root, destination);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error(`Seed file escaped its root: ${file.path}`);
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.content, "utf8");
  }
}
