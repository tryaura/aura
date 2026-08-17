import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { captureFilesystem, diffFilesystem } from "./filesystem.js";
import type { TestFileDiff, TestSeed } from "./types.js";

const JOURNAL_ENTRY = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d{4})?$/u;
const CONVERGED_MARKERS = ["Already converged — nothing to do.", "Nothing to fix."];

/** The common result surface returned by the testkit's setup and check runners. */
export interface ConvergenceRunResult {
  readonly diffs: readonly TestFileDiff[];
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface ConvergedTwiceResult<Result extends ConvergenceRunResult> {
  readonly first: Result;
  readonly second: Result;
}

/**
 * Runs one converge boundary twice and proves the second pass had no work to plan or journal.
 *
 * Throws framework-independent errors so distributions can use this helper from any test runner.
 */
export async function expectConvergedTwice<Result extends ConvergenceRunResult>(
  seed: TestSeed,
  run: () => Promise<Result>,
): Promise<ConvergedTwiceResult<Result>> {
  const first = await run();
  requireSuccessful("first", first);

  const afterFirst = await captureFilesystem(seed);
  const journalAfterFirst = await journalEntries(seed);
  const second = await run();
  requireSuccessful("second", second);

  const transcript = `${second.stdout}\n${second.stderr}`;
  if (!CONVERGED_MARKERS.some((marker) => transcript.includes(marker))) {
    throw convergenceError("second run did not report that it was already converged", second);
  }
  if (transcript.includes("Applied ")) {
    throw convergenceError("second run reported applied operations", second);
  }
  const reportedDiffs = second.diffs.filter((diff) => !isJournalPath(diff.path));
  if (reportedDiffs.length > 0) {
    throw convergenceError(
      `second run reported ${String(reportedDiffs.length)} filesystem diff(s): ${reportedDiffs
        .map((diff) => diff.path)
        .join(", ")}`,
      second,
    );
  }

  const afterSecond = await captureFilesystem(seed);
  const snapshotDiffs = diffFilesystem(afterFirst, afterSecond, (value) => value).filter(
    (diff) => !isJournalPath(diff.path),
  );
  if (snapshotDiffs.length > 0) {
    throw convergenceError(
      `second run changed ${String(snapshotDiffs.length)} captured path(s): ${snapshotDiffs
        .map((diff) => diff.path)
        .join(", ")}`,
      second,
    );
  }

  const journalAfterSecond = await journalEntries(seed);
  if (journalAfterSecond.join("\n") !== journalAfterFirst.join("\n")) {
    throw convergenceError("second run changed the undo journal entries", second);
  }

  return Object.freeze({ first, second });
}

/**
 * Whether a path belongs to the undo journal rather than to the state being converged.
 *
 * The journal is where a run records what it replaced, and it holds the target-lock directory a run
 * touches whether or not it writes anything. Convergence is a claim about the machine's
 * configuration, so journal paths are excluded here and asserted separately, by entry name.
 */
function isJournalPath(path: string): boolean {
  return path.includes("/.backups/") || path.endsWith("/.backups");
}

function requireSuccessful(label: string, result: ConvergenceRunResult): void {
  if (result.exitCode !== 0) {
    throw convergenceError(`${label} run exited with ${String(result.exitCode)}`, result);
  }
}

async function journalEntries(seed: TestSeed): Promise<readonly string[]> {
  try {
    return (await readdir(join(seed.homeDir, "agents", ".backups")))
      .filter((name) => JOURNAL_ENTRY.test(name))
      .sort();
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function convergenceError(message: string, result: ConvergenceRunResult): Error {
  return new Error(
    [
      `Expected converge-twice invariant: ${message}.`,
      `  stdout: ${result.stdout === "" ? "<empty>" : result.stdout}`,
      `  stderr: ${result.stderr === "" ? "<empty>" : result.stderr}`,
    ].join("\n"),
  );
}
