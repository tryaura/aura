import { isAbsolute, join, resolve } from "node:path";

import {
  detectExecutable,
  type Environment,
  type GitignoreModel,
  type GitignorePattern,
  type RepositoryModel,
} from "@tryaura/aura-sdk";

import type { FileReader } from "./reader.js";

const GIT_TIMEOUT_MS = 5_000;

/**
 * Tracked paths worth retaining, expressed as Git pathspecs.
 *
 * `ls-files` with no pathspec lists the whole checkout, which is unbounded and almost entirely
 * irrelevant to a check. Narrowing here keeps the cost proportional to what Aura can act on.
 */
const AGENT_PATHSPECS: readonly string[] = [
  ".claude/settings.local.json",
  ".cursor/mcp.json",
  ".mcp.json",
  "AGENTS.md",
  "CLAUDE.md",
];

/** Captures repository state needed by pure checks without letting checks perform I/O. */
export async function scanRepository(
  projectRoot: string,
  environment: Environment,
  reader: FileReader,
): Promise<RepositoryModel> {
  const gitignorePath = join(projectRoot, ".gitignore");
  const [gitignore, git] = await Promise.all([
    readGitignore(gitignorePath, reader),
    probeGit(projectRoot, environment),
  ]);

  const infoExclude =
    git.commonDir === undefined
      ? undefined
      : await readGitignore(join(git.commonDir, "info", "exclude"), reader);

  return {
    gitignore,
    ...(infoExclude === undefined ? {} : { infoExclude }),
    ...(git.trackedAgentPaths === undefined ? {} : { trackedAgentPaths: git.trackedAgentPaths }),
  };
}

async function readGitignore(path: string, reader: FileReader): Promise<GitignoreModel> {
  const file = await reader.read(path);
  const content = file.content;

  return {
    ...(content === undefined ? {} : { content }),
    exists: file.exists,
    path,
    patterns: content === undefined ? [] : parseGitignorePatterns(content),
    ...(file.problem === undefined ? {} : { problem: file.problem }),
  };
}

function parseGitignorePatterns(content: string): readonly GitignorePattern[] {
  const patterns: GitignorePattern[] = [];
  const lines = content.split(/\r?\n/u);

  for (const [index, value] of lines.entries()) {
    if (value.trim().length === 0 || value.startsWith("#")) {
      continue;
    }
    patterns.push({ line: index + 1, value });
  }

  return patterns;
}

interface GitProbe {
  /** Absolute path to the shared Git directory, which is where `info/exclude` lives. */
  readonly commonDir?: string | undefined;
  readonly trackedAgentPaths?: readonly string[] | undefined;
}

/**
 * Asks Git for the two things the model needs, tolerating every way Git can be unavailable.
 *
 * A missing Git, a repository Git refuses to open, and a command that times out are all reported
 * the same way: the corresponding field is absent, and checks treat absent as "unknown" rather
 * than as evidence.
 */
async function probeGit(projectRoot: string, environment: Environment): Promise<GitProbe> {
  try {
    const detection = await detectExecutable(environment, { binaryName: "git" });
    if (!detection.installed || detection.executablePath === undefined) {
      return {};
    }
    const command = detection.executablePath;

    const [commonDir, trackedAgentPaths] = await Promise.all([
      readCommonDir(command, projectRoot, environment),
      readTrackedAgentPaths(command, projectRoot, environment),
    ]);

    return {
      ...(commonDir === undefined ? {} : { commonDir }),
      ...(trackedAgentPaths === undefined ? {} : { trackedAgentPaths }),
    };
  } catch {
    return {};
  }
}

/** Resolves the shared Git directory, which for a worktree is not the local `.git`. */
async function readCommonDir(
  command: string,
  projectRoot: string,
  environment: Environment,
): Promise<string | undefined> {
  const result = await environment.exec({
    args: ["-C", projectRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    command,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    return undefined;
  }

  const path = result.stdout.trim();
  // `--path-format=absolute` is honored by current Git, but an older build silently ignores the
  // option and answers relatively, so the result is only trusted once it is actually absolute.
  return path.length === 0 || !isAbsolute(path) ? undefined : resolve(path);
}

async function readTrackedAgentPaths(
  command: string,
  projectRoot: string,
  environment: Environment,
): Promise<readonly string[] | undefined> {
  const result = await environment.exec({
    args: ["-C", projectRoot, "ls-files", "-z", "--", ...AGENT_PATHSPECS],
    command,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    return undefined;
  }

  return result.stdout.split("\0").filter((path) => path.length > 0);
}
