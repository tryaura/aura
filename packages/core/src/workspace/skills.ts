import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseSkillFrontmatter,
  parseSkillReferences,
  type DriverSkillPack,
  type DriverSkillSource,
  type Environment,
  type ResolvedSkillPack,
  type SharedSkillState,
} from "@tryaura/aura-sdk";

import type { RegisteredSkillPack } from "../plugin-registry.js";
import type { ScanDiagnostic } from "./diagnostics.js";
import type { FileReader } from "./reader.js";
import { sharedSkillsRoot } from "./skill-deployment-plan.js";
import { DRIVER_WALK_POLICY, treeHash, walkTree, type WalkedTree } from "./skill-tree-walk.js";

const SKILLS_DIAGNOSTIC_ID = "core/skills";
const SKILL_FILE = "SKILL.md";

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

export type DriverSkillPackResolution =
  | { readonly kind: "invalid" }
  | { readonly kind: "resolved"; readonly value: ResolvedSkillPack };

/** Safely reads one driver-materialized directory without exposing its rejected data. */
export async function resolveDriverSkillPack(
  skill: DriverSkillPack,
  source: DriverSkillSource,
  reader: FileReader,
): Promise<DriverSkillPackResolution> {
  let path: string;
  try {
    path = fileURLToPath(skill.source.url);
  } catch {
    return { kind: "invalid" };
  }
  const tree = await walkTree(path, reader, DRIVER_WALK_POLICY);
  if (tree.problem !== undefined || !tree.files.some((file) => file.path === SKILL_FILE)) {
    return { kind: "invalid" };
  }
  return {
    kind: "resolved",
    value: Object.freeze({
      description: skill.description,
      files: tree.files,
      id: skill.id,
      name: skill.name,
      originUrl: skill.originUrl,
      source,
      treeHash: treeHash(tree.files),
      version: skill.version,
    }),
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
 * The walker stops at the first entry it cannot resolve, and it walks in sorted order, so a single
 * unsupported sibling that sorts before `SKILL.md` leaves the definition unvisited. Calling that
 * "missing" would send the user to repair a file that is already correct, so an aborted walk
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
