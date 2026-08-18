import { isAbsolute, sep } from "node:path";

import type { Adapter, AdapterFileSpec, AdapterSourceFile, FileProblem } from "@tryaura/aura-sdk";

import { FILE_PROBLEM_MESSAGES } from "../file-problem-messages.js";
import type { ScanDiagnostic } from "./diagnostics.js";
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_FILE_BYTES,
  type FileReader,
  type PathContents,
} from "./reader.js";

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
  /** Canonical Aura-owned skill root that project skill links may deliberately bridge to. */
  readonly sharedSkillsRoot?: string | undefined;
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
 * Every outcome still yields exactly one {@link AdapterSourceFile}, keyed by its spec id when core
 * hands the completed discovery map to `parse`.
 */
export async function readSpec(spec: AdapterFileSpec, options: SpecReadOptions): Promise<SpecRead> {
  const invalid = invalidSpec(spec, options.adapter);
  if (invalid !== undefined) {
    return invalid;
  }

  const escape = await findEscape(spec, options);
  if (escape !== undefined) {
    return escapedSpec(spec, options.adapter, escape);
  }

  const contents = await readDeclaredPath(spec, options.reader);
  const resolvedPath =
    contents.pathKind === "symlink" ? await options.reader.realPath(spec.path) : undefined;
  const file = toSourceFile(spec, contents, resolvedPath);

  return { diagnostics: describe(spec, options.adapter, contents.problem, file.exists), file };
}

function invalidSpec(spec: AdapterFileSpec, adapter: Adapter): SpecRead | undefined {
  if (!isAbsolute(spec.path)) {
    return invalid(
      adapter,
      spec,
      `with the relative path ${spec.path}. Adapter paths must be absolute — build them from Environment.homeDir or Environment.cwd`,
    );
  }
  if (spec.maxBytes !== undefined && (!Number.isSafeInteger(spec.maxBytes) || spec.maxBytes < 0)) {
    return invalid(
      adapter,
      spec,
      "with an invalid maxBytes value. It must be a non-negative integer",
    );
  }
  if (spec.projectBoundary !== undefined && !isAbsolute(spec.projectBoundary)) {
    return invalid(
      adapter,
      spec,
      "with a relative project boundary. Project boundaries must be absolute",
    );
  }
  return undefined;
}

function invalid(adapter: Adapter, spec: AdapterFileSpec, reason: string): SpecRead {
  return {
    diagnostics: [
      {
        adapterId: adapter.id,
        message: `${adapter.displayName} declares "${spec.id}" ${reason}. Aura did not read it.`,
        path: spec.path,
        phase: "files",
      },
    ],
    file: { exists: false, spec },
  };
}

function escapedSpec(spec: AdapterFileSpec, adapter: Adapter, escape: ProjectEscape): SpecRead {
  return {
    diagnostics: [
      {
        adapterId: adapter.id,
        message: `${adapter.displayName} declares the project ${spec.kind} file ${spec.path}, but it resolves to ${escape.path}, outside ${escape.boundary}. Aura did not read it; a link like this in a checked-out repository is how a project reaches into your home directory.`,
        path: spec.path,
        phase: "read",
      },
    ],
    file: { exists: true, problem: "outside-project", spec },
  };
}

async function readDeclaredPath(spec: AdapterFileSpec, reader: FileReader): Promise<PathContents> {
  if (spec.kind === "probe" && reader.inspect !== undefined) {
    return reader.inspect(spec.path);
  }
  const maxBytes = spec.maxBytes;
  return reader.read(
    spec.path,
    maxBytes === undefined ? undefined : { maxBytes: Math.min(maxBytes, MAX_FILE_BYTES) },
  );
}

function toSourceFile(
  spec: AdapterFileSpec,
  contents: PathContents,
  resolvedPath?: string,
): AdapterSourceFile {
  const captured = spec.kind === "probe";
  return {
    ...(captured || contents.content === undefined ? {} : { content: contents.content }),
    ...(captured || contents.entries === undefined ? {} : { entries: contents.entries }),
    exists: contents.exists,
    ...(contents.pathKind === undefined ? {} : { pathKind: contents.pathKind }),
    problem: contents.problem,
    ...(resolvedPath === undefined ? {} : { resolvedPath }),
    ...(contents.size === undefined ? {} : { size: contents.size }),
    spec,
    ...(contents.symlinkTarget === undefined ? {} : { symlinkTarget: contents.symlinkTarget }),
  };
}

/**
 * Resolves a project-scoped path and returns where it landed, when that is outside the project.
 *
 * Global-scope paths are adapter-authored locations under the home directory and are not subject
 * to this: the untrusted input is the repository the user happens to have checked out.
 */
interface ProjectEscape {
  readonly boundary: string;
  readonly path: string;
}

// fallow-ignore-next-line complexity -- each guard preserves one project-boundary security case.
async function findEscape(
  spec: AdapterFileSpec,
  options: SpecReadOptions,
): Promise<ProjectEscape | undefined> {
  if (spec.scope !== "project") {
    return undefined;
  }

  const requestedBoundary = spec.projectBoundary ?? options.projectBoundary;
  if (requestedBoundary === undefined) {
    return undefined;
  }
  const projectBoundary =
    spec.projectBoundary === undefined
      ? requestedBoundary
      : await options.reader.realPath(requestedBoundary);
  if (projectBoundary === undefined) {
    return { boundary: requestedBoundary, path: spec.path };
  }
  const resolved = await options.reader.realPath(spec.path);
  if (
    resolved === undefined ||
    contains(projectBoundary, resolved) ||
    (spec.kind === "skills" &&
      options.sharedSkillsRoot !== undefined &&
      contains(options.sharedSkillsRoot, resolved))
  ) {
    return undefined;
  }

  return { boundary: projectBoundary, path: resolved };
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

/** The shared table, with the limit-bearing entries wrapped to name the limits applied here. */
const PROBLEM_REASONS: Readonly<Record<FileProblem, string>> = {
  ...FILE_PROBLEM_MESSAGES,
  "too-large": `the file is larger than the ${MAX_FILE_BYTES / 1_000_000} MB Aura reads`,
  "too-many-entries": `the path holds more than the ${MAX_DIRECTORY_ENTRIES} entries Aura lists`,
  unsupported: "the path is not a regular file or a directory",
};
