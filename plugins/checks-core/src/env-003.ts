import ignore from "ignore";

import {
  defineCheck,
  type DetectedFinding,
  type Finding,
  type FixPlan,
  type GitignoreModel,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";

import { reconcileGitignoreBlock } from "./gitignore-block.js";

const LOCAL_SETTINGS_PATH = ".claude/settings.local.json";

/** Paths that hold one developer's own agent state and should not reach the shared history. */
const PERSONAL_PATHS: readonly string[] = [LOCAL_SETTINGS_PATH];

/** Paths that carry team configuration and must stay commit-ready. */
const SHAREABLE_PATHS: readonly string[] = ["AGENTS.md", "CLAUDE.md", ".mcp.json"];

const EXPLAIN = `Personal agent overrides should stay out of version control, while shared instruction and MCP configuration should remain commit-ready. Aura evaluates the repository's root .gitignore together with .git/info/exclude, using Git-style pattern semantics including negations and rule order. Nested .gitignore files and a global core.excludesFile are not read, so \`git check-ignore -v <path>\` is the authority whenever the two disagree.

The automatic fix maintains a final ENV-003 block in the root .gitignore, and only ever adds rules for agent-owned paths. If a personal file was already tracked, ignore rules cannot remove it from the index; review it, then run \`git rm --cached -- <path>\` manually.`;

export const env003 = defineCheck({
  defaultSeverity: "warn",
  detect: (model) => detectGitignoreFindings(model),
  explain: EXPLAIN,
  fix: (finding, model) => fixGitignore(finding, model),
  fixability: "auto",
  id: "ENV-003",
  scope: "project",
  title: "Repository ignore rules separate personal and shared agent state",
});

function detectGitignoreFindings(model: WorkspaceModel): readonly DetectedFinding[] {
  const repository = model.repository;
  if (repository === undefined) {
    return [];
  }
  if (repository.gitignore.problem !== undefined) {
    return [
      {
        details: `Aura could not read ${repository.gitignore.path}: ${repository.gitignore.problem}.`,
        id: "gitignore-unreadable",
        locations: [{ path: repository.gitignore.path }],
        message: "The repository .gitignore could not be inspected.",
      },
    ];
  }

  // Rules from both files decide whether a path is already handled, so a developer who excluded a
  // personal path locally is not told to commit the same rule to everyone else's .gitignore.
  const matcher = ignore().add([
    ...patternsOf(repository.gitignore),
    ...patternsOf(repository.infoExclude),
  ]);
  const personalNotIgnored = PERSONAL_PATHS.filter((path) => !matcher.ignores(path));
  const shareableIgnored = SHAREABLE_PATHS.filter((path) => matcher.ignores(path));
  const findings: DetectedFinding[] = [];

  if (personalNotIgnored.length > 0 || shareableIgnored.length > 0) {
    findings.push({
      details: policyDetail(personalNotIgnored, shareableIgnored),
      id: "gitignore-policy",
      locations: [{ path: repository.gitignore.path }],
      message: "The repository .gitignore does not follow Aura's agent-file policy.",
      metadata: { personalNotIgnored, shareableIgnored },
    });
  }

  for (const path of repository.trackedAgentPaths ?? []) {
    if (PERSONAL_PATHS.includes(path) && matcher.ignores(path)) {
      findings.push({
        details: `Review the file, then run \`git rm --cached -- ${shellArgument(path)}\` if it should remain local.`,
        id: `ignored-but-tracked:${path}`,
        message: `${path} is ignored but already tracked by Git.`,
        metadata: { path },
        severity: "info",
      });
    }
  }

  return findings;
}

function patternsOf(gitignore: GitignoreModel | undefined): readonly string[] {
  return gitignore === undefined ? [] : gitignore.patterns.map((pattern) => pattern.value);
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Describes the policy in terms of the repository's own paths.
 *
 * Every path named here is one the developer can go and look at. Nothing internal to how the
 * check tests its rules reaches this text.
 */
function policyDetail(
  personalNotIgnored: readonly string[],
  shareableIgnored: readonly string[],
): string {
  return [
    ...(personalNotIgnored.length === 0
      ? []
      : [`Personal paths not ignored: ${personalNotIgnored.join(", ")}.`]),
    ...(shareableIgnored.length === 0
      ? []
      : [`Shareable paths currently ignored: ${shareableIgnored.join(", ")}.`]),
  ].join(" ");
}

function fixGitignore(finding: Finding, model: WorkspaceModel): FixPlan | undefined {
  if (finding.id !== "gitignore-policy") {
    return undefined;
  }
  const gitignore = model.repository?.gitignore;
  if (gitignore === undefined || gitignore.problem !== undefined) {
    return undefined;
  }

  const content = reconcileGitignoreBlock(gitignore.content ?? "");
  if (content === undefined) {
    return undefined;
  }

  return {
    operations: [{ content, path: gitignore.path, type: "write" }],
    summary: "Update Aura's managed agent-file rules in .gitignore.",
  };
}
