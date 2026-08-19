import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseSkillFrontmatter,
  parseSkillReferences,
  type Environment,
  type FileProblem,
  type ResolvedSkillFile,
  type ResolvedSkillPack,
  type SharedSkillEntry,
  type SharedSkillState,
} from "@tryaura/aura-sdk";

import type { RegisteredSkillPack } from "../plugin-registry.js";
import type { ScanDiagnostic } from "./diagnostics.js";
import type { FileReader, PathContents } from "./reader.js";
import { sharedSkillsRoot } from "./skill-deployment-plan.js";

const SKILLS_DIAGNOSTIC_ID = "core/skills";
const SKILL_FILE = "SKILL.md";

interface WalkedTree {
  readonly entries: readonly SharedSkillEntry[];
  readonly files: readonly ResolvedSkillFile[];
  readonly problem?: WalkProblem | undefined;
}

interface WalkProblem {
  readonly kind: FileProblem;
  readonly message: string;
}

/** Canonical shared skill root for one captured environment. */
function sharedSkillsPath(environment: Pick<Environment, "homeDir">): string {
  return sharedSkillsRoot(environment.homeDir);
}

/** Resolves every bundled skill pack without letting one broken pack hide the others. */
export async function resolveBundledSkills(
  registrations: readonly RegisteredSkillPack[],
  reader: FileReader,
): Promise<{
  readonly diagnostics: readonly ScanDiagnostic[];
  readonly skills: readonly ResolvedSkillPack[];
}> {
  const outcomes = await Promise.all(
    registrations.map(async ({ skill, source }) => {
      let path: string;
      try {
        path = fileURLToPath(skill.source.url);
      } catch {
        return { message: "source is not an absolute file: URL", skill };
      }
      const tree = await walkTree(path, reader);
      if (tree.problem !== undefined) {
        return { message: tree.problem.message, path, skill };
      }
      if (!tree.files.some((file) => file.path === SKILL_FILE)) {
        return { message: `does not contain ${SKILL_FILE}`, path, skill };
      }
      return {
        resolved: Object.freeze({
          description: skill.description,
          files: tree.files,
          id: skill.id,
          name: skill.name,
          source,
          treeHash: treeHash(tree.files),
          version: skill.version,
        }),
        skill,
      };
    }),
  );

  return {
    diagnostics: Object.freeze(
      outcomes.flatMap((outcome): readonly ScanDiagnostic[] =>
        "resolved" in outcome
          ? []
          : [
              {
                adapterId: SKILLS_DIAGNOSTIC_ID,
                message: `Skill "${outcome.skill.id}" ${outcome.message}, so it is unavailable.`,
                ...(outcome.path === undefined ? {} : { path: outcome.path }),
                phase: "read",
              },
            ],
      ),
    ),
    skills: Object.freeze(
      outcomes.flatMap((outcome): readonly ResolvedSkillPack[] =>
        "resolved" in outcome ? [outcome.resolved] : [],
      ),
    ),
  };
}

/** Reads every skill below the canonical shared directory. */
export async function scanSharedSkills(
  environment: Pick<Environment, "homeDir">,
  reader: FileReader,
): Promise<readonly SharedSkillState[]> {
  const root = sharedSkillsPath(environment);
  const contents = await reader.read(root);
  if (!contents.exists || contents.entries === undefined) {
    return [];
  }

  return Object.freeze(
    await Promise.all(
      contents.entries.map(async (id): Promise<SharedSkillState> => {
        const path = join(root, id);
        const tree = await walkTree(path, reader);
        const definition = sharedSkillDefinition(path, tree, environment.homeDir);
        return {
          ...definition,
          entries: tree.entries,
          id,
          path,
          ...(tree.problem === undefined
            ? { treeHash: treeHash(tree.files) }
            : { problem: tree.problem.kind, problemDetail: tree.problem.message }),
        };
      }),
    ),
  );
}

/**
 * Describes the skill definition, distinguishing an absent one from an unread one.
 *
 * {@link walkPath} stops at the first entry it cannot resolve, and it walks in sorted order, so a
 * single unsupported sibling that sorts before `SKILL.md` leaves the definition unvisited. Calling
 * that "missing" would send the user to repair a file that is already correct, so an aborted walk
 * reports `unreadable` and leaves the real cause to travel in `problemDetail`.
 */
function sharedSkillDefinition(
  path: string,
  tree: WalkedTree,
  homeDir: string,
): Pick<
  SharedSkillState,
  | "definitionStatus"
  | "description"
  | "invalidFrontmatterFields"
  | "name"
  | "references"
  | "skillFilePath"
  | "version"
> {
  const skillFilePath = join(path, SKILL_FILE);
  const file = tree.files.find((entry) => entry.path === SKILL_FILE);
  if (file === undefined) {
    return {
      definitionStatus: tree.problem === undefined ? "missing-file" : "unreadable",
      skillFilePath,
    };
  }
  const frontmatter = parseSkillFrontmatter(file.content);
  const existing = new Set(tree.entries.map((entry) => resolve(entry.path)));
  const references = parseSkillReferences(file.content, {
    homeDir,
    skillRoot: path,
    sourcePath: skillFilePath,
  }).map((reference) => ({ ...reference, valid: existing.has(resolve(reference.path)) }));
  return {
    ...(frontmatter.description === undefined ? {} : { description: frontmatter.description }),
    definitionStatus: frontmatter.parsed ? "ready" : "invalid-frontmatter",
    ...(frontmatter.invalidFields.length === 0
      ? {}
      : { invalidFrontmatterFields: frontmatter.invalidFields }),
    ...(frontmatter.name === undefined ? {} : { name: frontmatter.name }),
    references,
    skillFilePath,
    ...(frontmatter.version === undefined ? {} : { version: frontmatter.version }),
  };
}

/** Deterministic, platform-independent signature of a normalized skill tree. */
export function treeHash(files: readonly ResolvedSkillFile[]): string {
  const signature = [...files]
    .map((file) => ({ ...file, path: file.path.replaceAll("\\", "/") }))
    .sort((left, right) => comparePortablePaths(left.path, right.path))
    .map(
      (file) => `f:${file.path}:${createHash("sha256").update(file.content, "utf8").digest("hex")}`,
    )
    .join("\n");
  return createHash("sha256").update(`${signature}\n`, "utf8").digest("hex");
}

async function walkTree(root: string, reader: FileReader): Promise<WalkedTree> {
  const files: ResolvedSkillFile[] = [];
  const entries: SharedSkillEntry[] = [];
  const problem = await walkPath(resolve(root), resolve(root), reader, files, entries);
  return {
    entries: Object.freeze(entries),
    files: Object.freeze(files.sort((left, right) => comparePortablePaths(left.path, right.path))),
    ...(problem === undefined ? {} : { problem }),
  };
}

// fallow-ignore-next-line complexity -- every branch rejects or resolves one filesystem entry kind.
async function walkPath(
  root: string,
  path: string,
  reader: FileReader,
  files: ResolvedSkillFile[],
  entries: SharedSkillEntry[],
): Promise<WalkProblem | undefined> {
  const contents = await reader.read(path);
  const relativePath = portablePath(relative(root, path));
  if (!contents.exists) {
    return {
      kind: "unreadable",
      message: `${relativePath || "."} does not exist`,
    };
  }
  if (contents.pathKind === "symlink") {
    return {
      kind: "unsupported",
      message: `${relativePath || "."} is a symbolic link`,
    };
  }
  if (contents.problem !== undefined) {
    return {
      kind: contents.problem,
      message: `${relativePath || "."} could not be read (${contents.problem})`,
    };
  }
  if (contents.entries !== undefined) {
    entries.push({ kind: "directory", path });
    for (const entry of contents.entries) {
      const problem = await walkPath(root, join(path, entry), reader, files, entries);
      if (problem !== undefined) {
        return problem;
      }
    }
    return undefined;
  }
  return addFile(path, relativePath, contents, files, entries);
}

function addFile(
  path: string,
  relativePath: string,
  contents: PathContents,
  files: ResolvedSkillFile[],
  entries: SharedSkillEntry[],
): WalkProblem | undefined {
  if (contents.content === undefined) {
    return {
      kind: "unsupported",
      message: `${relativePath} is not a readable regular file`,
    };
  }
  if (contents.utf8Valid === false) {
    return {
      kind: "unsupported",
      message: `${relativePath} is not valid UTF-8`,
    };
  }
  entries.push({ kind: "file", path });
  files.push({ content: contents.content, path: relativePath });
  return undefined;
}

function portablePath(path: string): string {
  return sep === "/" ? path : path.replaceAll(sep, "/");
}

function comparePortablePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
