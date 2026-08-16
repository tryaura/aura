import type { FileProblem } from "./adapter.js";

/** One effective pattern line from a repository's root `.gitignore`. */
export interface GitignorePattern {
  /** One-based line number in `.gitignore`. */
  readonly line: number;
  /** Exact pattern text, excluding the line ending. */
  readonly value: string;
}

/** State of one file holding Git ignore patterns, captured during the workspace scan. */
export interface GitignoreModel {
  /** Exact file contents, absent when the file could not be read. */
  readonly content?: string | undefined;
  /** Whether the file exists. */
  readonly exists: boolean;
  /** Absolute path to the file. */
  readonly path: string;
  /** Effective nonblank, non-comment lines in source order. */
  readonly patterns: readonly GitignorePattern[];
  /** Why contents are unavailable when the path exists but could not be read. */
  readonly problem?: FileProblem | undefined;
}

/** Repository-specific state checks need without performing their own I/O. */
export interface RepositoryModel {
  /** Root `.gitignore`, the only ignore file Aura offers to maintain. */
  readonly gitignore: GitignoreModel;
  /**
   * Repository-local `info/exclude`, which ignores paths without touching a shared file.
   *
   * Read so that a developer who already excluded a personal path locally is not told to commit
   * the same rule to everyone else's `.gitignore`. Absent when Git could not be probed.
   */
  readonly infoExclude?: GitignoreModel | undefined;
  /**
   * Root-relative tracked paths that agent applications are known to write.
   *
   * Deliberately not every tracked path: a checkout can hold hundreds of thousands of files, and
   * retaining all of them for the lifetime of a scan costs far more than the handful of agent
   * paths a check can act on. Undefined when Git could not be probed.
   */
  readonly trackedAgentPaths?: readonly string[] | undefined;
}
