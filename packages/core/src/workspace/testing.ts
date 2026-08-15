import type {
  Adapter,
  AdapterDetection,
  AdapterFileSpec,
  AdapterParseInput,
  AdapterSnapshot,
  Environment,
  InstructionDocument,
  InstructionLink,
} from "@tryaura/aura-sdk";

import type { FileReader, PathContents } from "./reader.js";

/** Marks an entry of {@link createMemoryReader} as a directory rather than a file. */
export const DIRECTORY = null;

/** A {@link FileReader} over a literal filesystem, recording every path it was asked for. */
export interface MemoryReader extends FileReader {
  /** Paths passed to `read`, in call order. */
  readonly reads: readonly string[];
}

/** Creates a reader over an in-memory filesystem: absolute path to contents, or {@link DIRECTORY}. */
export function createMemoryReader(
  entries: Readonly<Record<string, string | typeof DIRECTORY>> = {},
): MemoryReader {
  const reads: string[] = [];

  return {
    read: (path) => {
      reads.push(path);
      return Promise.resolve(toContents(entries[path]));
    },
    reads,
  };
}

function toContents(entry: string | typeof DIRECTORY | undefined): PathContents {
  if (entry === undefined) {
    return { exists: false, isDirectory: false };
  }

  if (entry === DIRECTORY) {
    return { exists: true, isDirectory: true };
  }

  return { content: entry, exists: true, isDirectory: false };
}

/** Overridable parts of {@link createTestEnvironment}. */
export interface TestEnvironmentOptions {
  readonly cwd?: string | undefined;
  readonly homeDir?: string | undefined;
}

/** An {@link Environment} whose exec and clock are inert; the model builder uses neither. */
export function createTestEnvironment(options: TestEnvironmentOptions = {}): Environment {
  return {
    cwd: options.cwd ?? "/workspace",
    exec: () => Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }),
    homeDir: options.homeDir ?? "/home/dev",
    now: () => new Date(0),
    pathEntries: [],
    platform: "linux",
  };
}

/** Overridable parts of {@link createTestAdapter}. Every default describes a working adapter. */
export interface TestAdapterOptions {
  readonly detect?: (() => Promise<AdapterDetection>) | undefined;
  readonly files?: (() => readonly AdapterFileSpec[]) | undefined;
  readonly id?: string | undefined;
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
    parse: options.parse ?? (() => createSnapshot()),
    supportedRange: options.supportedRange ?? ">=1 <2",
  };
}

/** Builds an {@link AdapterSnapshot}, defaulting every collection to empty. */
export function createSnapshot(snapshot: Partial<AdapterSnapshot> = {}): AdapterSnapshot {
  return {
    instructionFiles: snapshot.instructionFiles ?? [],
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
