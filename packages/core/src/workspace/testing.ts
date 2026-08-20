import type {
  Adapter,
  AdapterParseInput,
  AdapterSnapshot,
  Environment,
  FileProblem,
  InstructionDocument,
  InstructionLink,
} from "@tryaura/aura-sdk";
import { Buffer } from "node:buffer";

import type { FileReadOptions, FileReader, PathContents } from "./reader.js";
import { containsPath } from "./path-containment.js";

/** Marks an entry of {@link createMemoryReader} as a directory rather than a file. */
export const DIRECTORY = null;

/** The literal filesystem {@link createMemoryReader} serves: absolute path to contents. */
export type MemoryEntries = Readonly<Record<string, string | typeof DIRECTORY>>;

/** The parts of a filesystem that are not contents. */
export interface MemoryReaderOptions {
  /** Absolute path to the canonical path it resolves to, for symlink tests. */
  readonly links?: Readonly<Record<string, string>> | undefined;
  /** Paths that exist but cannot be read, and why. */
  readonly problems?: Readonly<Record<string, FileProblem>> | undefined;
}

/** A {@link FileReader} over a literal filesystem, recording every path it was asked for. */
export interface MemoryReader extends FileReader {
  /** Paths passed to `exists` or `inspect`, in call order. */
  readonly probes: readonly string[];
  /** Paths passed to `read`, in call order. */
  readonly reads: readonly string[];
}

/** Creates a reader over an in-memory filesystem. Directory entries are derived from the paths. */
export function createMemoryReader(
  entries: MemoryEntries = {},
  options: MemoryReaderOptions = {},
): MemoryReader {
  const probes: string[] = [];
  const reads: string[] = [];

  return {
    exists: (path) => {
      probes.push(path);
      return Promise.resolve(options.problems?.[path] !== undefined || entries[path] !== undefined);
    },
    inspect: (path) => {
      probes.push(path);
      const problem = options.problems?.[path];
      if (problem !== undefined) {
        return Promise.resolve({ exists: true, isDirectory: false, problem });
      }
      return Promise.resolve(withoutMemoryContents(path, entries));
    },
    probes,
    read: (path, readOptions) => {
      reads.push(path);
      const problem = options.problems?.[path];
      if (problem !== undefined) {
        return Promise.resolve({ exists: true, isDirectory: false, problem });
      }

      return Promise.resolve(toContents(path, entries, readOptions));
    },
    readWithin: (path, directories, readOptions) => {
      reads.push(path);
      const problem = options.problems?.[path];
      const link = options.links?.[path];
      // Absence settles before containment, as it does on a real filesystem: nothing stands at the
      // path, so there is nothing that could have escaped and nothing to refuse. A link counts as
      // something standing there, whether or not this filesystem also holds its target.
      if (problem === undefined && link === undefined && entries[path] === undefined) {
        return Promise.resolve({ contents: { exists: false, isDirectory: false }, kind: "read" });
      }
      const resolvedPath = link ?? path;
      if (!directories.some((directory) => containsPath(directory, resolvedPath))) {
        return Promise.resolve({
          contents: { exists: true, isDirectory: false, problem: "outside-project" },
          kind: "outside",
          resolvedPath,
        });
      }
      return Promise.resolve({
        contents:
          problem === undefined
            ? toContents(path, entries, readOptions)
            : { exists: true, isDirectory: false, problem },
        kind: "read",
        resolvedPath,
      });
    },
    // A memory filesystem has no reason to fail resolution, so an unlinked path is its own target.
    realPath: (path) => Promise.resolve(options.links?.[path] ?? path),
    reads,
  };
}

function toContents(path: string, entries: MemoryEntries, options?: FileReadOptions): PathContents {
  const entry = entries[path];

  if (entry === undefined) {
    return { exists: false, isDirectory: false };
  }

  if (entry === DIRECTORY) {
    return {
      entries: childrenOf(path, entries),
      exists: true,
      isDirectory: true,
      pathKind: "directory",
    };
  }

  const contents = Buffer.from(entry, "utf8");
  return {
    content:
      options?.maxBytes === undefined
        ? entry
        : contents.subarray(0, options.maxBytes).toString("utf8"),
    exists: true,
    isDirectory: false,
    pathKind: "file",
    ...(options?.maxBytes === undefined ? {} : { size: contents.length }),
  };
}

function withoutMemoryContents(path: string, entries: MemoryEntries): PathContents {
  const contents = toContents(path, entries);
  const entry = entries[path];
  return {
    exists: contents.exists,
    isDirectory: contents.isDirectory,
    ...(contents.pathKind === undefined ? {} : { pathKind: contents.pathKind }),
    ...(typeof entry === "string" ? { size: Buffer.byteLength(entry, "utf8") } : {}),
  };
}

/** Immediate children of a directory, taken from the paths the filesystem declares. */
function childrenOf(directory: string, entries: MemoryEntries): readonly string[] {
  const prefix = directory.endsWith("/") ? directory : `${directory}/`;

  return Object.keys(entries)
    .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
    .map((path) => path.slice(prefix.length))
    .sort();
}

/** Overridable parts of {@link createTestEnvironment}. */
export interface TestEnvironmentOptions {
  readonly cwd?: string | undefined;
  readonly homeDir?: string | undefined;
  /** Scripted network responses; the default fails every request without touching a socket. */
  readonly httpGet?: Environment["httpGet"] | undefined;
  /** Variables served by `readVariable`; empty by default. */
  readonly variables?: Readonly<Record<string, string>> | undefined;
}

/** An {@link Environment} whose exec, network, and clock are inert; the model builder uses none. */
export function createTestEnvironment(options: TestEnvironmentOptions = {}): Environment {
  return {
    cwd: options.cwd ?? "/workspace",
    exec: () => Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }),
    homeDir: options.homeDir ?? "/home/dev",
    httpGet: options.httpGet ?? (() => Promise.resolve({ kind: "failure", reason: "network" })),
    now: () => new Date(0),
    pathEntries: [],
    platform: "linux",
    readVariable: (name) => options.variables?.[name],
  };
}

/** Overridable parts of {@link createTestAdapter}. Every default describes a working adapter. */
export interface TestAdapterOptions {
  readonly detect?: Adapter["detect"] | undefined;
  readonly files?: Adapter["files"] | undefined;
  readonly id?: string | undefined;
  readonly installHint?: string | undefined;
  readonly mcpWrite?: Adapter["mcpWrite"] | undefined;
  readonly mcpSecrets?: Adapter["mcpSecrets"] | undefined;
  readonly parse?: ((input: AdapterParseInput) => AdapterSnapshot) | undefined;
  readonly supportedRange?: string | undefined;
}

/** Creates an adapter that is installed, declares nothing, and parses nothing. */
export function createTestAdapter(options: TestAdapterOptions = {}): Adapter {
  const id = options.id ?? "fake";

  return {
    detect: options.detect ?? (() => Promise.resolve({ installed: true, version: "1.0.0" })),
    displayName: `Fake ${id}`,
    files: options.files ?? (() => []),
    id,
    ...(options.installHint === undefined ? {} : { installHint: options.installHint }),
    ...(options.mcpWrite === undefined ? {} : { mcpWrite: options.mcpWrite }),
    ...(options.mcpSecrets === undefined ? {} : { mcpSecrets: options.mcpSecrets }),
    parse: options.parse ?? (() => createSnapshot()),
    supportedRange: options.supportedRange ?? ">=1 <2",
  };
}

/** Builds an {@link AdapterSnapshot}, defaulting every collection to empty. */
export function createSnapshot(snapshot: Partial<AdapterSnapshot> = {}): AdapterSnapshot {
  return {
    instructionFiles: snapshot.instructionFiles ?? [],
    mcpSecretSightings: snapshot.mcpSecretSightings ?? [],
    mcpServers: snapshot.mcpServers ?? [],
    metadata: snapshot.metadata,
    skills: snapshot.skills ?? [],
  };
}

/** Builds an {@link InstructionDocument} whose links start out claiming to be valid. */
export function createDocument(
  path: string,
  links: readonly InstructionLink[] = [],
): InstructionDocument {
  return { content: "", links, path, scope: "global", sourceId: "instructions" };
}

/** Builds an {@link InstructionLink} with the placeholder validity an adapter would report. */
export function createLink(targetPath: string, valid = true): InstructionLink {
  return { kind: "import", targetPath, valid };
}
