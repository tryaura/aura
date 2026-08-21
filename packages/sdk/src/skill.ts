import { dirname, isAbsolute, join, resolve } from "node:path";

import { parseDocument } from "yaml";

import type {
  AdapterFileSpec,
  AdapterFilesInput,
  AdapterParseInput,
  AdapterSourceFile,
} from "./adapter.js";
import type { AdapterSkillDirectory } from "./capabilities.js";
import type {
  InstalledSkill,
  InvalidSkillFrontmatterField,
  ResolvedSkillDirectory,
  SkillDefinitionStatus,
} from "./skill-model.js";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

/**
 * The largest `SKILL.md` Aura parses, in bytes.
 *
 * A skill definition is a Markdown document a human wrote, so it is bounded by what a person would
 * tolerate reading. The bound matters because every declaration is handed to a YAML parser on every
 * scan: without it, one oversized file makes every command that builds the model pay for it.
 */
const MAX_SKILL_DEFINITION_BYTES = 256_000;

export { parseSkillReferences } from "./skill-references.js";

/** Resolves a portable adapter skill-directory declaration. */
export function resolveSkillDirectory(
  directory: AdapterSkillDirectory,
  homeDir: string,
): ResolvedSkillDirectory {
  const path = directory.entryPath.slice(2);
  return {
    id: directory.id,
    path: join(homeDir, ...path.split("/")),
  };
}

/** Declares skill roots, their immediate children, and each child's `SKILL.md`. */
export function skillDirectorySpecs(
  input: AdapterFilesInput,
  directories: readonly AdapterSkillDirectory[],
): readonly AdapterFileSpec[] {
  return directories.flatMap((directory) => {
    const resolved = resolveSkillDirectory(directory, input.environment.homeDir);
    const root = skillSpec(directory.id, resolved.path);
    const entries = input.files.get(directory.id)?.entries ?? [];
    return [
      root,
      ...entries.flatMap((entry) => skillEntrySpecs(directory.id, entry, resolved.path, input)),
    ];
  });
}

/** Parses every directory or symlink entry, including incomplete and dangling skills. */
export function parseInstalledSkills(
  appId: string,
  input: AdapterParseInput,
  directories: readonly AdapterSkillDirectory[],
): readonly InstalledSkill[] {
  return directories.flatMap((directory) => {
    const resolved = resolveSkillDirectory(directory, input.homeDir);
    const entries = input.files.get(directory.id)?.entries ?? [];
    return entries.flatMap((id): readonly InstalledSkill[] => {
      const skill = installedSkill(appId, input, directory, resolved, id);
      return skill === undefined ? [] : [skill];
    });
  });
}

function installedSkill(
  appId: string,
  input: AdapterParseInput,
  directory: AdapterSkillDirectory,
  resolved: ResolvedSkillDirectory,
  id: string,
): InstalledSkill | undefined {
  const childId = childSourceId(directory.id, id);
  const child = input.files.get(childId);
  if (child === undefined || (child.pathKind !== "directory" && child.pathKind !== "symlink")) {
    return undefined;
  }
  const path = join(resolved.path, id);
  const skillFilePath = join(path, "SKILL.md");
  const skillFile = input.files.get(`${childId}/SKILL.md`);
  const frontmatter = parseSkillFrontmatter(skillFile?.content ?? "");
  const name = frontmatter.name?.trim() || id;
  return {
    appId,
    ...frontmatterFields(frontmatter, id, name),
    definitionStatus: definitionStatus(skillFile, frontmatter.parsed),
    id,
    name,
    path,
    skillFilePath,
    sourceId: directory.id,
    ...symlinkFields(child),
  };
}

function frontmatterFields(frontmatter: SkillFrontmatter, id: string, name: string) {
  return {
    ...(frontmatter.description === undefined ? {} : { description: frontmatter.description }),
    ...(frontmatter.invalidFields.length === 0
      ? {}
      : { invalidFrontmatterFields: frontmatter.invalidFields }),
    ...(name === id ? {} : { invocationName: name }),
    ...(frontmatter.version === undefined ? {} : { version: frontmatter.version }),
  };
}

function symlinkFields(child: AdapterSourceFile) {
  const symlinkTargetPath = absoluteSymlinkTarget(child.spec.path, child.symlinkTarget);
  return {
    ...(symlinkTargetPath === undefined ? {} : { symlinkTargetPath }),
    ...(child.resolvedPath === undefined ? {} : { symlinkResolvedPath: child.resolvedPath }),
  };
}

/** The fields Aura reads out of an Agent Skills frontmatter block. */
export interface SkillFrontmatter {
  /** The `description` field, when it is present and a string. */
  readonly description?: string | undefined;
  /** Present fields whose values were not strings, so their value was discarded. */
  readonly invalidFields: readonly InvalidSkillFrontmatterField[];
  /** The `name` field, when it is present and a string. Not validated against the name grammar. */
  readonly name?: string | undefined;
  /**
   * Whether a frontmatter block was present and parsed into a YAML mapping.
   *
   * This is a parse outcome, not a verdict on the skill: `parsed` is true for a block whose fields
   * all had the wrong type, and those fields are named in {@link SkillFrontmatter.invalidFields}.
   */
  readonly parsed: boolean;
  /** `metadata.version`, falling back to the legacy top-level `version`. */
  readonly version?: string | undefined;
}

/** Reads the standard name and description, `metadata.version`, and legacy top-level version. */
export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const block = FRONTMATTER_PATTERN.exec(content)?.[1];
  if (block === undefined) {
    return { invalidFields: [], parsed: false };
  }
  const document = parseDocument(block, { prettyErrors: false, strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    return { invalidFields: [], parsed: false };
  }
  let mapping: unknown;
  try {
    mapping = document.toJS({ maxAliasCount: 0 });
  } catch {
    return { invalidFields: [], parsed: false };
  }
  if (!isRecord(mapping)) {
    return { invalidFields: [], parsed: false };
  }

  const invalidFields: InvalidSkillFrontmatterField[] = [];
  const description = stringField(mapping, "description", invalidFields);
  const name = stringField(mapping, "name", invalidFields);
  const topLevelVersion = stringField(mapping, "version", invalidFields);
  const metadata = mapping["metadata"];
  const metadataVersion = isRecord(metadata)
    ? stringField(metadata, "version", invalidFields)
    : undefined;
  return {
    ...(description === undefined ? {} : { description }),
    invalidFields: Object.freeze([...new Set(invalidFields)]),
    ...(name === undefined ? {} : { name }),
    parsed: true,
    ...((metadataVersion ?? topLevelVersion) === undefined
      ? {}
      : { version: metadataVersion ?? topLevelVersion }),
  };
}

function skillEntrySpecs(
  rootId: string,
  entry: string,
  rootPath: string,
  input: AdapterFilesInput,
): readonly AdapterFileSpec[] {
  const childId = childSourceId(rootId, entry);
  const childPath = join(rootPath, entry);
  const child = skillSpec(childId, childPath);
  if (input.files.get(childId)?.entries === undefined) {
    return [child];
  }
  return [child, definitionSpec(`${childId}/SKILL.md`, join(childPath, "SKILL.md"))];
}

function definitionStatus(
  file: AdapterSourceFile | undefined,
  parsedFrontmatter: boolean,
): SkillDefinitionStatus {
  if (file === undefined || !file.exists) {
    return "missing-file";
  }
  if (file.problem !== undefined || file.content === undefined) {
    return "unreadable";
  }
  return parsedFrontmatter ? "ready" : "invalid-frontmatter";
}

function absoluteSymlinkTarget(path: string, target: string | undefined): string | undefined {
  if (target === undefined) {
    return undefined;
  }
  return isAbsolute(target) ? resolve(target) : resolve(dirname(path), target);
}

function skillSpec(id: string, path: string): AdapterFileSpec {
  return { id, kind: "skills", optional: true, path, scope: "global" };
}

function definitionSpec(id: string, path: string): AdapterFileSpec {
  return { ...skillSpec(id, path), maxBytes: MAX_SKILL_DEFINITION_BYTES };
}

function childSourceId(rootId: string, entry: string): string {
  return `${rootId}/${encodeURIComponent(entry)}`;
}

function stringField(
  value: Readonly<Record<string, unknown>>,
  field: InvalidSkillFrontmatterField,
  invalid: InvalidSkillFrontmatterField[],
): string | undefined {
  const candidate = value[field];
  if (candidate === undefined) {
    return undefined;
  }
  if (typeof candidate === "string") {
    return candidate;
  }
  invalid.push(field);
  return undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
