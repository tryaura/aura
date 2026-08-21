import ignore from "ignore";

import {
  defineCheck,
  type DetectedFinding,
  type GitignoreModel,
  type RepositoryModel,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";

import { abandonedBlock, abandonedBlockDetail } from "./env-003-legacy.js";

const LOCAL_SETTINGS_PATH = ".claude/settings.local.json";

/** Paths that hold one developer's own agent state and should not reach the shared history. */
const PERSONAL_PATHS: readonly string[] = [LOCAL_SETTINGS_PATH];

/** Paths that carry team configuration and must stay commit-ready. */
const SHAREABLE_PATHS: readonly string[] = ["AGENTS.md", "CLAUDE.md", ".mcp.json"];

const EXPLAIN = `Personal agent overrides should stay out of version control, while shared instruction and MCP configuration should remain commit-ready. Aura evaluates the repository's root .gitignore together with .git/info/exclude, using Git-style pattern semantics including negations and rule order. Nested .gitignore files and a global core.excludesFile are not read, so \`git check-ignore -v <path>\` is the authority whenever the two disagree.

Aura never edits repository files. Update the root .gitignore manually if this policy does not match, and use \`git check-ignore -v <path>\` to verify the result. If a personal file was already tracked, ignore rules cannot remove it from the index; review it, then run \`git rm --cached -- <path>\` manually. Earlier releases maintained an \`# aura:begin ENV-003\` block in this file; Aura no longer writes or repairs it, and reports it once so the rules become yours rather than something carrying Aura's name that nothing updates.`;

export const env003 = defineCheck({
  defaultSeverity: "warn",
  detect: (model) => detectGitignoreFindings(model),
  explain: EXPLAIN,
  fixability: "manual",
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
        fixability: "manual",
        id: "gitignore-unreadable",
        locations: [{ path: repository.gitignore.path }],
        message: "The repository .gitignore could not be inspected.",
      },
    ];
  }

  return [
    ...policyFindings(repository),
    ...abandonedBlockFindings(repository.gitignore),
    ...trackedPersonalFindings(repository.trackedAgentPaths ?? []),
  ];
}

function abandonedBlockFindings(gitignore: GitignoreModel): readonly DetectedFinding[] {
  const block = abandonedBlock(gitignore);
  return block === undefined
    ? []
    : [
        {
          details: abandonedBlockDetail(gitignore.path, block),
          fixability: "manual",
          id: "managed-block-abandoned",
          locations: [{ path: gitignore.path }],
          message: "An earlier Aura release left a managed block in this repository's .gitignore.",
          severity: "info",
        },
      ];
}

function policyFindings(repository: RepositoryModel): readonly DetectedFinding[] {
  const infoExclude = repository.infoExclude;

  if (infoExclude?.problem !== undefined) {
    return [
      {
        details: `Aura could not read ${infoExclude.path}: ${infoExclude.problem}. Ignore-policy findings are omitted because the effective Git rules are unknown.`,
        fixability: "manual",
        id: "info-exclude-unreadable",
        locations: [{ path: infoExclude.path }],
        message: "The repository-local Git exclude file could not be inspected.",
      },
    ];
  }

  // Git evaluates repository-local excludes below per-directory .gitignore rules. The ignore
  // package is last-match-wins, so adding the root file last reproduces that precedence.
  const matcher = ignore({ ignorecase: false }).add([
    ...patternsOf(infoExclude),
    ...patternsOf(repository.gitignore),
  ]);
  const personalNotIgnored = PERSONAL_PATHS.filter((path) => !matcher.ignores(path));
  const shareableIgnored = SHAREABLE_PATHS.filter((path) => matcher.ignores(path));
  return personalNotIgnored.length === 0 && shareableIgnored.length === 0
    ? []
    : [
        {
          details: policyDetail(personalNotIgnored, shareableIgnored),
          id: "gitignore-policy",
          locations: [{ path: repository.gitignore.path }],
          message: "The repository .gitignore does not follow Aura's agent-file policy.",
          metadata: { personalNotIgnored, shareableIgnored },
        },
      ];
}

function trackedPersonalFindings(paths: readonly string[]): readonly DetectedFinding[] {
  return paths.flatMap((path) =>
    PERSONAL_PATHS.includes(path)
      ? [
          {
            details: `Review the file, then run \`git rm --cached -- ${shellArgument(path)}\` if it should remain local.`,
            // Named for the state it reports: the path no longer has to be ignored to qualify, and
            // an id that still said "ignored" would describe a condition Aura never checked.
            fixability: "manual",
            id: `tracked-personal-path:${path}`,
            message: `${path} is already tracked by Git but should remain personal.`,
            metadata: { path },
            severity: "info",
          },
        ]
      : [],
  );
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
