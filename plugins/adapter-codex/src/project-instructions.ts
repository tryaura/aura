import { join } from "node:path";

import type { AdapterFileMap, AdapterFileSpec, Environment } from "@tryaura/aura-sdk";

import { CODEX_OVERRIDE_SUFFIX, codexProjectInstructionsId } from "./contract.js";
import { DEFAULT_PROJECT_ROOT_MARKERS, type CodexProjectSettings } from "./config.js";
import { ancestorDirectories, projectDirectories } from "./project-directories.js";

/** Probes configured candidates, then declares only the project instruction files Codex selects. */
export function codexProjectInstructionFiles(
  environment: Environment,
  files: AdapterFileMap,
  projectRoot: string | undefined,
  settings: CodexProjectSettings,
): readonly AdapterFileSpec[] {
  const repositoryDirectories = projectDirectories({ cwd: environment.cwd, projectRoot });
  const rootDiscovery = configuredProjectDirectories(
    environment.cwd,
    repositoryDirectories,
    settings,
    files,
  );
  const declarations = [...rootDiscovery.probes];
  if (rootDiscovery.directories === undefined) {
    return declarations;
  }

  const levels = projectInstructionLevels(
    rootDiscovery.directories,
    settings,
    rootDiscovery.boundary,
  );
  const candidateProbes = levels.flatMap((level) => level.map((candidate) => candidate.probe));
  declarations.push(...candidateProbes);
  if (candidateProbes.some((probe) => !files.has(probe.id))) {
    return declarations;
  }

  let bytesRemaining = settings.maxBytes;
  for (const level of levels) {
    const selected = selectedProjectCandidate(level, files);
    if (selected === undefined || bytesRemaining === 0) {
      continue;
    }
    declarations.push({ ...selected.spec, maxBytes: bytesRemaining });
    bytesRemaining = remainingBytes(selected, files, bytesRemaining);
  }
  return declarations;
}

interface ProjectRootDiscovery {
  readonly boundary: string | undefined;
  readonly directories: readonly string[] | undefined;
  readonly probes: readonly AdapterFileSpec[];
}

function configuredProjectDirectories(
  cwd: string,
  repositoryDirectories: readonly string[],
  settings: CodexProjectSettings,
  files: AdapterFileMap,
): ProjectRootDiscovery {
  if (
    settings.rootMarkers.length === DEFAULT_PROJECT_ROOT_MARKERS.length &&
    settings.rootMarkers[0] === DEFAULT_PROJECT_ROOT_MARKERS[0]
  ) {
    return { boundary: undefined, directories: repositoryDirectories, probes: [] };
  }
  if (settings.rootMarkers.length === 0) {
    const directories = repositoryDirectories.slice(0, 1);
    return { boundary: directories[0], directories, probes: [] };
  }

  const directories = ancestorDirectories(cwd);
  const probeBoundary = directories[directories.length - 1];
  const probes = directories.flatMap((directory, ancestors) =>
    settings.rootMarkers.map((marker, markerIndex): AdapterFileSpec => ({
      id: `codex.project-root.${String(ancestors)}.${String(markerIndex)}.probe`,
      kind: "probe",
      optional: true,
      path: join(directory, marker),
      ...(probeBoundary === undefined ? {} : { projectBoundary: probeBoundary }),
      scope: "project",
    })),
  );
  if (probes.some((probe) => !files.has(probe.id))) {
    return { boundary: undefined, directories: undefined, probes };
  }

  const rootIndex = directories.findIndex((_directory, ancestors) =>
    settings.rootMarkers.some((_marker, markerIndex) => {
      const probe = files.get(
        `codex.project-root.${String(ancestors)}.${String(markerIndex)}.probe`,
      );
      return probe?.exists === true && probe.problem === undefined;
    }),
  );
  const selectedDirectories =
    rootIndex === -1 ? directories.slice(0, 1) : directories.slice(0, rootIndex + 1);
  return {
    boundary: selectedDirectories[selectedDirectories.length - 1],
    directories: selectedDirectories,
    probes,
  };
}

interface ProjectInstructionCandidate {
  readonly probe: AdapterFileSpec;
  readonly spec: AdapterFileSpec;
}

function projectInstructionLevels(
  directories: readonly string[],
  settings: CodexProjectSettings,
  projectBoundary: string | undefined,
): readonly (readonly ProjectInstructionCandidate[])[] {
  return directories
    .map((directory, ancestors) => {
      const id = codexProjectInstructionsId(ancestors);
      return [
        projectCandidate(
          directory,
          `${id}${CODEX_OVERRIDE_SUFFIX}`,
          "AGENTS.override.md",
          settings,
          projectBoundary,
        ),
        projectCandidate(directory, id, "AGENTS.md", settings, projectBoundary),
        ...settings.fallbackFilenames.map((filename, index) =>
          projectCandidate(
            directory,
            `${id}.fallback.${String(index)}`,
            filename,
            settings,
            projectBoundary,
          ),
        ),
      ];
    })
    .reverse();
}

function projectCandidate(
  directory: string,
  id: string,
  filename: string,
  settings: CodexProjectSettings,
  projectBoundary: string | undefined,
): ProjectInstructionCandidate {
  const path = join(directory, filename);
  return {
    probe: {
      id: `${id}.probe`,
      kind: "probe",
      optional: true,
      path,
      ...(projectBoundary === undefined ? {} : { projectBoundary }),
      scope: "project",
    },
    spec: {
      id,
      kind: "instructions",
      maxBytes: settings.maxBytes,
      optional: true,
      path,
      ...(projectBoundary === undefined ? {} : { projectBoundary }),
      scope: "project",
    },
  };
}

function selectedProjectCandidate(
  candidates: readonly ProjectInstructionCandidate[],
  files: AdapterFileMap,
): ProjectInstructionCandidate | undefined {
  for (const candidate of candidates) {
    const probe = files.get(candidate.probe.id);
    if (probe?.problem !== undefined) {
      return undefined;
    }
    if (
      probe?.exists === true &&
      (probe.pathKind === "file" || (probe.pathKind === "symlink" && probe.size !== undefined))
    ) {
      return candidate;
    }
  }
  return undefined;
}

function remainingBytes(
  selected: ProjectInstructionCandidate,
  files: AdapterFileMap,
  remaining: number,
): number {
  const size = files.get(selected.probe.id)?.size;
  if (size === undefined) {
    return 0;
  }
  return Math.max(0, remaining - size);
}
