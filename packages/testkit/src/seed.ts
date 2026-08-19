import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

import { hashRepoPreset, MAX_TRUSTED_REPO_PRESETS } from "@tryaura/core";

import { readInvocations, validateShim, writeShim } from "./shims.js";
import type { SeedContent, SeedRoots, ShimResponse, TestSeed, TestSeedBuilder } from "./types.js";

interface SeedFile {
  readonly content: SeedContent;
  readonly path: string;
}

interface SeedShim {
  readonly command: string;
  readonly responses: readonly ShimResponse[];
}

interface SeedTrustedRepoPreset {
  readonly [key: string]: unknown;
  readonly hash: string;
  readonly path: string;
}

class SeedBuilder implements TestSeedBuilder {
  readonly #homeFiles = new Map<string, SeedFile>();
  readonly #shims = new Map<string, SeedShim>();
  readonly #trustedPresets = new Set<string>();
  readonly #workspaceFiles = new Map<string, SeedFile>();

  homeFile(path: string, content: SeedContent): TestSeedBuilder {
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

  trustWorkspacePreset(path = ".aura/preset.json"): TestSeedBuilder {
    this.#trustedPresets.add(normalizeSeedPath(path));
    return this;
  }

  workspaceFile(path: string, content: SeedContent): TestSeedBuilder {
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
      const roots: SeedRoots = { homeDir, workspaceDir };
      await Promise.all([
        writeFiles(homeDir, this.#homeFiles.values(), roots),
        writeFiles(workspaceDir, this.#workspaceFiles.values(), roots),
      ]);
      await Promise.all(
        [...this.#shims.values()].map((shim) =>
          writeShim({ command: shim.command, logDir, pathDir, responses: shim.responses }),
        ),
      );
      if (this.#trustedPresets.size > 0) {
        await recordTrustedPresets(homeDir, workspaceDir, this.#trustedPresets);
      }
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

/**
 * Merges trust records for the seeded presets into the seed's manifest.
 *
 * A trust record binds an absolute preset path to a hash of its contents, and both exist only
 * once the seed is materialized, so this runs after the files are written and reads them back.
 */
async function recordTrustedPresets(
  homeDir: string,
  workspaceDir: string,
  presets: ReadonlySet<string>,
): Promise<void> {
  const manifestPath = join(homeDir, "agents", "aura.json");
  const existing = await readFile(manifestPath, "utf8").catch(() => undefined);
  const manifest: Record<string, unknown> =
    existing === undefined
      ? { apps: {}, mcpServers: [], ownership: {}, schemaVersion: 1, skills: [], snippets: [] }
      : parseSeedManifest(existing, manifestPath);
  const added: SeedTrustedRepoPreset[] = [];
  for (const relativePath of presets) {
    const path = join(workspaceDir, relativePath);
    const content = await readFile(path, "utf8").catch(() => {
      throw new Error(`trustWorkspacePreset needs the seeded workspace file: ${relativePath}`);
    });
    added.push({ hash: hashRepoPreset(content), path });
  }
  const addedPaths = new Set(added.map((entry) => entry.path));
  const trustedRepoPresets = [
    ...parseTrustedRepoPresets(manifest["trustedRepoPresets"], manifestPath).filter(
      (entry) => !addedPaths.has(entry.path),
    ),
    ...added,
  ];
  if (trustedRepoPresets.length > MAX_TRUSTED_REPO_PRESETS) {
    throw new Error(
      `Seed manifest ${manifestPath} exceeds the ${String(MAX_TRUSTED_REPO_PRESETS)} trusted repository preset limit`,
    );
  }
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...manifest, trustedRepoPresets }, undefined, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function parseSeedManifest(source: string, path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(source);
  if (!isRecord(value)) {
    throw new Error(`Seed manifest ${path} must contain a JSON object`);
  }
  return value;
}

function parseTrustedRepoPresets(
  value: unknown,
  manifestPath: string,
): readonly SeedTrustedRepoPreset[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Seed manifest ${manifestPath} trustedRepoPresets must be an array`);
  }
  return value.map((candidate, index) => {
    if (
      !isRecord(candidate) ||
      typeof candidate["hash"] !== "string" ||
      typeof candidate["path"] !== "string"
    ) {
      throw new Error(
        `Seed manifest ${manifestPath} trustedRepoPresets[${String(index)}] must contain string hash and path fields`,
      );
    }
    return { ...candidate, hash: candidate["hash"], path: candidate["path"] };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addFile(
  files: Map<string, SeedFile>,
  scope: string,
  path: string,
  content: SeedContent,
): void {
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
 * Materializes one root's files, resolving any content declared as a function of the roots.
 *
 * Sequential on purpose: two declared paths can disagree about whether a name is a file or a
 * directory, and writing them in declaration order makes which one fails deterministic.
 */
async function writeFiles(
  root: string,
  files: Iterable<SeedFile>,
  roots: SeedRoots,
): Promise<void> {
  for (const file of files) {
    const destination = join(root, file.path);
    const fromRoot = relative(root, destination);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error(`Seed file escaped its root: ${file.path}`);
    }
    const content = typeof file.content === "string" ? file.content : file.content(roots);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
}
