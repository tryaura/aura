import type { AdapterFileSpec } from "@tryaura/aura-sdk";

import { containsPath } from "./path-containment.js";
import { MAX_FILE_BYTES, type FileReader, type PathContents } from "./reader.js";

/** A project path and the boundary its resolved target escaped. */
export interface ProjectEscape {
  readonly boundary: string;
  readonly path: string;
}

interface DeclaredPathRead {
  readonly contents: PathContents;
  readonly kind: "read";
  readonly resolvedPath?: string | undefined;
}

interface EscapedPathRead {
  readonly escape: ProjectEscape;
  readonly kind: "escape";
}

/** The path could not be shown to be the object that was opened, so nothing was captured. */
interface UnverifiedPathRead {
  readonly kind: "unverified";
}

export type SpecPathRead = DeclaredPathRead | EscapedPathRead | UnverifiedPathRead;

export interface SpecPathReadOptions {
  readonly projectBoundary: string | undefined;
  readonly reader: FileReader;
  readonly sharedSkillsRoot?: string | undefined;
}

/** Reads one valid spec using an atomic containment-and-read operation when it is project-scoped. */
export async function readSpecPath(
  spec: AdapterFileSpec,
  options: SpecPathReadOptions,
): Promise<SpecPathRead> {
  const projectScope = await resolveProjectScope(spec, options);
  if (projectScope?.kind === "escape") {
    return { escape: projectScope.escape, kind: "escape" };
  }
  return readForScope(spec, options.reader, projectScope);
}

interface BoundedProjectScope {
  readonly boundary: string;
  readonly directories: readonly string[];
  readonly kind: "bounded";
}

interface EscapedProjectScope {
  readonly escape: ProjectEscape;
  readonly kind: "escape";
}

async function resolveProjectScope(
  spec: AdapterFileSpec,
  options: SpecPathReadOptions,
): Promise<BoundedProjectScope | EscapedProjectScope | undefined> {
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
    return {
      escape: { boundary: requestedBoundary, path: spec.path },
      kind: "escape",
    };
  }

  return {
    boundary: projectBoundary,
    directories:
      spec.kind === "skills" && options.sharedSkillsRoot !== undefined
        ? [projectBoundary, options.sharedSkillsRoot]
        : [projectBoundary],
    kind: "bounded",
  };
}

async function readForScope(
  spec: AdapterFileSpec,
  reader: FileReader,
  projectScope: BoundedProjectScope | undefined,
): Promise<SpecPathRead> {
  if (spec.kind === "probe") {
    return readProbe(spec, reader, projectScope);
  }
  if (projectScope !== undefined) {
    return readBoundedDeclaredPath(spec, reader, projectScope);
  }
  return readUnboundedDeclaredPath(spec, reader);
}

async function readProbe(
  spec: AdapterFileSpec,
  reader: FileReader,
  projectScope: BoundedProjectScope | undefined,
): Promise<SpecPathRead> {
  if (projectScope !== undefined) {
    const escape = await findProbeEscape(spec, reader, projectScope);
    if (escape !== undefined) {
      return { escape, kind: "escape" };
    }
  }
  return { contents: await readDeclaredPath(spec, reader), kind: "read" };
}

async function readBoundedDeclaredPath(
  spec: AdapterFileSpec,
  reader: FileReader,
  projectScope: BoundedProjectScope,
): Promise<SpecPathRead> {
  const bounded = await reader.readWithin(
    spec.path,
    projectScope.directories,
    fileReadOptions(spec),
  );
  if (bounded.kind === "outside") {
    return {
      escape: { boundary: projectScope.boundary, path: bounded.resolvedPath },
      kind: "escape",
    };
  }
  if (bounded.kind === "unverified") {
    return { kind: "unverified" };
  }
  return {
    contents: bounded.contents,
    kind: "read",
    ...(bounded.contents.pathKind === "symlink" && bounded.resolvedPath !== undefined
      ? { resolvedPath: bounded.resolvedPath }
      : {}),
  };
}

async function readUnboundedDeclaredPath(
  spec: AdapterFileSpec,
  reader: FileReader,
): Promise<DeclaredPathRead> {
  const contents = await readDeclaredPath(spec, reader);
  const resolvedPath =
    contents.pathKind === "symlink" ? await reader.realPath(spec.path) : undefined;
  return {
    contents,
    kind: "read",
    ...(resolvedPath === undefined ? {} : { resolvedPath }),
  };
}

async function readDeclaredPath(spec: AdapterFileSpec, reader: FileReader): Promise<PathContents> {
  if (spec.kind === "probe" && reader.inspect !== undefined) {
    return reader.inspect(spec.path);
  }
  return reader.read(spec.path, fileReadOptions(spec));
}

function fileReadOptions(spec: AdapterFileSpec): { readonly maxBytes: number } | undefined {
  return spec.maxBytes === undefined
    ? undefined
    : { maxBytes: Math.min(spec.maxBytes, MAX_FILE_BYTES) };
}

async function findProbeEscape(
  spec: AdapterFileSpec,
  reader: FileReader,
  projectScope: BoundedProjectScope,
): Promise<ProjectEscape | undefined> {
  const resolved = await reader.realPath(spec.path);
  return resolved === undefined ||
    projectScope.directories.some((directory) => containsPath(directory, resolved))
    ? undefined
    : { boundary: projectScope.boundary, path: resolved };
}
