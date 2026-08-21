import { join } from "node:path";

import {
  parseSkillFrontmatter,
  type RepoSkillSource,
  type ResolvedSkillPack,
} from "@tryaura/aura-sdk";

import { MAX_REPO_SKILLS } from "../preset/repo-content-limits.js";
import type { ScanDiagnostic } from "../workspace/diagnostics.js";
import type { FileReader } from "../workspace/reader.js";
import {
  DRIVER_WALK_POLICY,
  treeHash,
  walkTree,
  type WalkPolicy,
} from "../workspace/skill-tree-walk.js";
import { skillIdProblem } from "./path-guards.js";

const REPO_SKILLS_DIAGNOSTIC_ID = "core/repo-skills";
const SKILL_FILE = "SKILL.md";

/** The one source id repository skills are offered under; one repository, one source. */
const REPO_SKILL_SOURCE_ID: RepoSkillSource["id"] = "repo:workspace";

/** The repository skills directory as a picker-facing source. */
function repoSkillSource(path: string): RepoSkillSource {
  return Object.freeze({ id: REPO_SKILL_SOURCE_ID, kind: "repo", name: "This repository", path });
}

export interface RepoSkillsResolution {
  readonly diagnostics: readonly ScanDiagnostic[];
  readonly skills: readonly ResolvedSkillPack[];
}

/**
 * Resolves every skill tree below `.aura/skills` into an installable pack.
 *
 * A broken entry earns a diagnostic and drops out rather than failing the run: unlike snippets,
 * these trees are outside the trust hash — they are offers the per-skill review gates, so an
 * unreadable one is a smaller catalog, not a broken consent record. Each tree walks under the
 * driver policy: a cloned tree deserves exactly the suspicion a driver-materialized one gets.
 */
export async function resolveRepoSkills(
  root: string,
  boundary: string,
  reader: FileReader,
  maxTotalBytes: number,
): Promise<RepoSkillsResolution> {
  const rootRead = await reader.readWithin(root, [boundary]);
  const { contents } = rootRead;
  if (!contents.exists) {
    return { diagnostics: [], skills: [] };
  }
  if (
    rootRead.kind !== "read" ||
    contents.pathKind === "symlink" ||
    contents.problem !== undefined ||
    contents.entries === undefined
  ) {
    return {
      diagnostics: [
        {
          adapterId: REPO_SKILLS_DIAGNOSTIC_ID,
          message: "Repository skills path .aura/skills is not a directory, so none are offered.",
          path: root,
          phase: "read",
        },
      ],
      skills: [],
    };
  }

  const diagnostics: ScanDiagnostic[] = [];
  const named = contents.entries.filter((entry) => !entry.startsWith("."));
  if (named.length > MAX_REPO_SKILLS) {
    diagnostics.push({
      adapterId: REPO_SKILLS_DIAGNOSTIC_ID,
      message:
        `Repository skills directory holds more than the ${String(MAX_REPO_SKILLS)} ` +
        `entries Aura offers; the rest are ignored.`,
      path: root,
      phase: "read",
    });
  }

  const skills: ResolvedSkillPack[] = [];
  const source = repoSkillSource(root);
  let bytesRead = 0;
  for (const id of named.slice(0, MAX_REPO_SKILLS)) {
    const remainingBytes = maxTotalBytes - bytesRead;
    if (remainingBytes <= 0) {
      diagnostics.push(diagnostic(join(root, id), "exceeds the repository content size budget"));
      continue;
    }
    const outcome = await resolveOneSkill(
      root,
      id,
      source,
      reader,
      boundary,
      remainingWalkPolicy(remainingBytes),
    );
    bytesRead += outcome.bytesRead;
    if (outcome.problem !== undefined) {
      diagnostics.push(
        diagnostic(
          join(root, id),
          outcome.bytesRead >= remainingBytes
            ? "exceeds the repository content size budget"
            : outcome.problem,
        ),
      );
      continue;
    }
    skills.push(outcome.skill);
  }
  return { diagnostics: Object.freeze(diagnostics), skills: Object.freeze(skills) };
}

async function resolveOneSkill(
  root: string,
  id: string,
  source: RepoSkillSource,
  reader: FileReader,
  boundary: string,
  policy: WalkPolicy,
): Promise<
  | { readonly bytesRead: number; readonly problem: string }
  | { readonly bytesRead: number; readonly problem?: undefined; readonly skill: ResolvedSkillPack }
> {
  const idProblem = skillIdProblem(id);
  if (idProblem !== undefined) {
    return { bytesRead: 0, problem: idProblem };
  }
  const tree = await walkTree(join(root, id), reader, policy, boundary);
  if (tree.problem !== undefined) {
    return { bytesRead: tree.bytesRead, problem: tree.problem.message };
  }
  const definition = tree.files.find((file) => file.path === SKILL_FILE);
  if (definition === undefined) {
    return { bytesRead: tree.bytesRead, problem: `does not contain ${SKILL_FILE}` };
  }
  const frontmatter = parseSkillFrontmatter(definition.content);
  return {
    bytesRead: tree.bytesRead,
    skill: Object.freeze({
      description: frontmatter.description ?? "Repository skill.",
      files: tree.files,
      id,
      name: frontmatter.name ?? id,
      source,
      treeHash: treeHash(tree.files),
      version: frontmatter.version ?? "0.0.0",
    }),
  };
}

/** Caps each attempt by what remains of the repository-wide read budget. */
function remainingWalkPolicy(remainingBytes: number): WalkPolicy {
  return Object.freeze({
    ...DRIVER_WALK_POLICY,
    maxFileBytes: Math.min(DRIVER_WALK_POLICY.maxFileBytes, remainingBytes),
    maxTotalBytes: Math.min(DRIVER_WALK_POLICY.maxTotalBytes, remainingBytes),
  });
}

function diagnostic(path: string, message: string): ScanDiagnostic {
  return {
    adapterId: REPO_SKILLS_DIAGNOSTIC_ID,
    message: `Repository skill ${message}, so it is not offered.`,
    path,
    phase: "read",
  };
}
