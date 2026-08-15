import { isAbsolute, sep } from "node:path";

import type { Adapter, AdapterFileSpec, AdapterSourceFile, FileProblem } from "@tryaura/aura-sdk";

import type { ScanDiagnostic } from "./diagnostics.js";
import { MAX_DIRECTORY_ENTRIES, MAX_FILE_BYTES, type FileReader } from "./reader.js";

/** One declared path, read, together with anything worth telling the user about it. */
export interface SpecRead {
  readonly diagnostics: readonly ScanDiagnostic[];
  readonly file: AdapterSourceFile;
}

/** Everything {@link readSpec} needs beyond the spec itself. */
export interface SpecReadOptions {
  /** The adapter that declared the spec, named in diagnostics. */
  readonly adapter: Adapter;
  /**
   * Canonical directory that project-scoped paths must stay inside, when one is known.
   *
   * The project root, or the working directory when the scan is not inside a repository.
   */
  readonly projectBoundary: string | undefined;
  readonly reader: FileReader;
}

/**
 * Reads one declared path, refusing the ones that should never reach the filesystem.
 *
 * Two refusals happen before any I/O. A relative path would be resolved by Node against the
 * process working directory, silently escaping the injected {@link Environment}. And a
 * project-scoped path that resolves outside the project is how a cloned repository reaches into a
 * home directory: `.mcp.json` symlinked at `~/.ssh/id_rsa` is read, parsed, and quoted back in
 * whatever the adapter throws.
 *
 * Every outcome still yields exactly one {@link AdapterSourceFile}, because `parse` is promised one
 * entry per spec in declaration order.
 */
export async function readSpec(spec: AdapterFileSpec, options: SpecReadOptions): Promise<SpecRead> {
  const { adapter } = options;

  if (!isAbsolute(spec.path)) {
    return {
      diagnostics: [
        {
          adapterId: adapter.id,
          message: `${adapter.displayName} declares "${spec.id}" with the relative path ${spec.path}. Adapter paths must be absolute — build them from Environment.homeDir or Environment.cwd. Aura did not read it.`,
          path: spec.path,
          phase: "files",
        },
      ],
      file: { exists: false, spec },
    };
  }

  const escape = await findEscape(spec, options);
  if (escape !== undefined) {
    return {
      diagnostics: [
        {
          adapterId: adapter.id,
          message: `${adapter.displayName} declares the project ${spec.kind} file ${spec.path}, but it resolves to ${escape}, outside ${options.projectBoundary}. Aura did not read it; a link like this in a checked-out repository is how a project reaches into your home directory.`,
          path: spec.path,
          phase: "read",
        },
      ],
      file: { exists: false, spec },
    };
  }

  const contents = await options.reader.read(spec.path);
  const file: AdapterSourceFile = {
    content: contents.content,
    entries: contents.entries,
    exists: contents.exists,
    problem: contents.problem,
    spec,
  };

  return { diagnostics: describe(spec, options.adapter, contents.problem, file.exists), file };
}

/**
 * Resolves a project-scoped path and returns where it landed, when that is outside the project.
 *
 * Global-scope paths are adapter-authored locations under the home directory and are not subject
 * to this: the untrusted input is the repository the user happens to have checked out.
 */
async function findEscape(
  spec: AdapterFileSpec,
  options: SpecReadOptions,
): Promise<string | undefined> {
  const { projectBoundary } = options;
  if (spec.scope !== "project" || projectBoundary === undefined) {
    return undefined;
  }

  const resolved = await options.reader.realPath(spec.path);
  if (resolved === undefined || contains(projectBoundary, resolved)) {
    return undefined;
  }

  return resolved;
}

function contains(directory: string, path: string): boolean {
  return (
    path === directory || path.startsWith(directory.endsWith(sep) ? directory : directory + sep)
  );
}

/** Turns the read outcome into the one sentence the user needs, or nothing when all is well. */
function describe(
  spec: AdapterFileSpec,
  adapter: Adapter,
  problem: FileProblem | undefined,
  exists: boolean,
): readonly ScanDiagnostic[] {
  if (problem !== undefined) {
    return [
      {
        adapterId: adapter.id,
        message: `${adapter.displayName} could not read its ${spec.kind} file at ${spec.path}: ${PROBLEM_REASONS[problem]}. Checks that rely on it were skipped.`,
        path: spec.path,
        phase: "read",
      },
    ];
  }

  // Optional paths are the common case — most applications only write config once the user has
  // configured something — so only a required path going missing is worth the user's attention.
  if (!exists && spec.optional !== true) {
    return [
      {
        adapterId: adapter.id,
        message: `${adapter.displayName} requires a ${spec.kind} file at ${spec.path}, but nothing exists there. Checks that rely on it were skipped.`,
        path: spec.path,
        phase: "read",
      },
    ];
  }

  return [];
}

const PROBLEM_REASONS: Readonly<Record<FileProblem, string>> = {
  denied: "permission was denied",
  loop: "the path is a loop of symbolic links",
  resources: "the system ran out of file handles",
  "too-large": `it is larger than the ${MAX_FILE_BYTES / 1_000_000} MB Aura reads`,
  "too-many-entries": `it holds more than the ${MAX_DIRECTORY_ENTRIES} entries Aura lists`,
  unreadable: "the filesystem reported an error",
  unsupported: "it is not a regular file or a directory",
};
