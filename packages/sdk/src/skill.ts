import { join } from "node:path";

import type { AdapterFileSpec, AdapterFilesInput, AdapterParseInput } from "./adapter.js";
import type { AdapterSkillDirectory } from "./capabilities.js";
import type { Scope } from "./common.js";
import type { InstalledSkill, ResolvedSkillDirectory } from "./skill-model.js";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const FIELD_PATTERN = /^([A-Za-z0-9_-]+):\s*(.*?)\s*$/u;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** Resolves a portable adapter skill-directory declaration. */
export function resolveSkillDirectory(
  directory: AdapterSkillDirectory,
  homeDir: string,
  cwd: string,
): ResolvedSkillDirectory {
  const global = directory.entryPath.startsWith("~/");
  const relative = directory.entryPath.slice(2).split("/");
  return {
    id: directory.id,
    path: join(global ? homeDir : cwd, ...relative),
    scope: global ? "global" : "project",
  };
}

/** Declares skill roots, their immediate children, and each child's `SKILL.md`. */
export function skillDirectorySpecs(
  input: AdapterFilesInput,
  directories: readonly AdapterSkillDirectory[],
): readonly AdapterFileSpec[] {
  return directories.flatMap((directory) => {
    const resolved = resolveSkillDirectory(
      directory,
      input.environment.homeDir,
      input.environment.cwd,
    );
    const root = skillSpec(directory.id, resolved.path, resolved.scope);
    const entries = input.files.get(directory.id)?.entries ?? [];
    return [
      root,
      ...entries.flatMap((entry) => {
        const childId = childSourceId(directory.id, entry);
        const childPath = join(resolved.path, entry);
        const child = skillSpec(childId, childPath, resolved.scope);
        return input.files.get(childId)?.entries === undefined
          ? [child]
          : [child, skillSpec(`${childId}/SKILL.md`, join(childPath, "SKILL.md"), resolved.scope)];
      }),
    ];
  });
}

/** Parses installed Agent Skills from specs produced by {@link skillDirectorySpecs}. */
export function parseInstalledSkills(
  appId: string,
  input: AdapterParseInput,
  directories: readonly AdapterSkillDirectory[],
): readonly InstalledSkill[] {
  return directories.flatMap((directory) => {
    const resolved = resolveSkillDirectory(directory, input.homeDir, input.cwd);
    const entries = input.files.get(directory.id)?.entries ?? [];
    return entries.flatMap((id): readonly InstalledSkill[] => {
      const childId = childSourceId(directory.id, id);
      const child = input.files.get(childId);
      const skillFile = input.files.get(`${childId}/SKILL.md`);
      if (child?.entries === undefined || skillFile?.content === undefined) {
        return [];
      }
      const metadata = parseSkillFrontmatter(skillFile.content);
      if (metadata.name === undefined) {
        return [];
      }
      return [
        {
          appId,
          id,
          ...(metadata.name === id ? {} : { invocationName: metadata.name }),
          name: metadata.name,
          path: join(resolved.path, id),
          scope: resolved.scope,
          sourceId: directory.id,
          ...(metadata.version === undefined ? {} : { version: metadata.version }),
        },
      ];
    });
  });
}

/** The fields Aura needs from Agent Skills frontmatter. */
export interface SkillFrontmatter {
  readonly name?: string | undefined;
  readonly version?: string | undefined;
}

/** Reads the standard name and metadata.version, plus legacy top-level version. */
// fallow-ignore-next-line complexity -- each branch handles one frontmatter shape or scope transition.
export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const block = FRONTMATTER_PATTERN.exec(content)?.[1];
  if (block === undefined) {
    return {};
  }
  let metadataIndent: number | undefined;
  let metadataVersion: string | undefined;
  let name: string | undefined;
  let version: string | undefined;
  for (const line of block.split(/\r?\n/u)) {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;
    if (metadataIndent !== undefined && indent > metadataIndent) {
      const field = FIELD_PATTERN.exec(trimmed);
      if (field?.[1] === "version") {
        metadataVersion = scalar(field[2]);
      }
      continue;
    }
    metadataIndent = undefined;
    const field = FIELD_PATTERN.exec(trimmed);
    if (field?.[1] === "metadata" && (field[2] ?? "").length === 0) {
      metadataIndent = indent;
    } else if (field?.[1] === "name") {
      name = validSkillName(scalar(field[2]));
    } else if (field?.[1] === "version") {
      version = scalar(field[2]);
    }
  }
  return {
    ...(name === undefined ? {} : { name }),
    ...((metadataVersion ?? version) === undefined ? {} : { version: metadataVersion ?? version }),
  };
}

function validSkillName(value: string | undefined): string | undefined {
  return value !== undefined && value.length <= 64 && SKILL_NAME_PATTERN.test(value)
    ? value
    : undefined;
}

function skillSpec(id: string, path: string, scope: Scope): AdapterFileSpec {
  return { id, kind: "skills", optional: true, path, scope };
}

function childSourceId(rootId: string, entry: string): string {
  return `${rootId}/${encodeURIComponent(entry)}`;
}

function scalar(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed.replace(/\s+#.*$/u, "");
}
