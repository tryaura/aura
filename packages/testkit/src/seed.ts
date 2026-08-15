import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

import { validateShim, writeShim } from "./shims.js";
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
    const root = await mkdtemp(join(tmpdir(), "aura-testkit-"));
    const homeDir = join(root, "home");
    const pathDir = join(root, "bin");
    const workspaceDir = join(root, "workspace");

    try {
      await Promise.all([
        mkdir(homeDir, { recursive: true }),
        mkdir(pathDir, { recursive: true }),
        mkdir(workspaceDir, { recursive: true }),
      ]);
      await writeFiles(homeDir, this.#homeFiles.values());
      await writeFiles(workspaceDir, this.#workspaceFiles.values());
      await Promise.all(
        [...this.#shims.values()].map((shim) => writeShim(pathDir, shim.command, shim.responses)),
      );
    } catch (error) {
      await rm(root, { force: true, recursive: true });
      throw error;
    }

    let cleanupPromise: Promise<void> | undefined;
    return Object.freeze({
      cleanup: () => {
        cleanupPromise ??= rm(root, { force: true, recursive: true });
        return cleanupPromise;
      },
      homeDir,
      pathDir,
      workspaceDir,
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
