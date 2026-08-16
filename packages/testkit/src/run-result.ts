import { dirname } from "node:path";

import type { CliExitCode } from "@tryaura/aura-cli";

import { captureFilesystem, diffFilesystem } from "./filesystem.js";
import { parseReport } from "./report.js";
import type { TestRunResult, TestSeed } from "./types.js";

interface CheckRunOutput {
  readonly stderr: string;
  readonly stdout: string;
}

/**
 * What running the CLI in this process reports.
 *
 * `runCli` both returns an exit code and applies one through `setExitCode`, and the two agreeing is
 * the invariant this boundary exists to prove. The applied code is therefore required rather than
 * optional: a run that never reported one is itself the regression worth failing on.
 */
interface InProcessCheckRun extends CheckRunOutput {
  readonly appliedExitCode: number | undefined;
  readonly boundary: "in-process";
  readonly exitCode: number;
}

/** What running a compiled distribution as a child process reports. */
export interface SpawnedCheckRun extends CheckRunOutput {
  readonly boundary: "spawned";
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Set when the runner killed the child for outliving its timeout. */
  readonly timedOutAfterMs?: number | undefined;
}

export type CheckRunCapture = InProcessCheckRun | SpawnedCheckRun;

interface RunTranscript {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOutAfterMs: number | undefined;
}

/** Converts either CLI execution boundary into the testkit's stable result contract. */
export async function collectCheckResult(
  seed: TestSeed,
  execute: () => Promise<CheckRunCapture>,
): Promise<TestRunResult> {
  const before = await captureFilesystem(seed);
  const capture = await execute();
  const normalize = createNormalizer(seed);
  const spawned = capture.boundary === "spawned";
  const transcript: RunTranscript = {
    exitCode: capture.exitCode,
    signal: spawned ? capture.signal : null,
    stderr: normalize(capture.stderr),
    stdout: normalize(capture.stdout),
    timedOutAfterMs: spawned ? capture.timedOutAfterMs : undefined,
  };

  const exitCode = requireExitCode(transcript);
  if (capture.boundary === "in-process") {
    requireAppliedExitCode(capture.appliedExitCode, exitCode, transcript);
  }

  const report = parseReport(transcript.stdout, (message) => runError(message, transcript));
  if (report.summary.exitCode !== exitCode) {
    throw runError(
      "Check runner saw a report and process with disagreeing exit codes.",
      transcript,
    );
  }

  const after = await captureFilesystem(seed);
  return Object.freeze({
    diffs: diffFilesystem(before, after, normalize),
    exitCode,
    findings: report.findings,
    report,
    stderr: transcript.stderr,
    stdout: transcript.stdout,
  });
}

/**
 * Proves the in-process run applied the exit code it returned.
 *
 * Only this boundary can disagree with itself: a child process has one exit status and no second
 * opinion to compare it against.
 */
function requireAppliedExitCode(
  appliedExitCode: number | undefined,
  exitCode: CliExitCode,
  transcript: RunTranscript,
): void {
  if (appliedExitCode === undefined) {
    throw runError("Check runner never reported the exit code it applied.", transcript);
  }
  if (appliedExitCode !== exitCode) {
    throw runError("Check runner saw two disagreeing exit codes for one run.", transcript);
  }
}

function requireExitCode(transcript: RunTranscript): CliExitCode {
  // Ahead of the signal check on purpose: a timed-out run is killed, so it always also arrives as a
  // signal, and "terminated from SIGKILL" is the one description of it that explains nothing.
  if (transcript.timedOutAfterMs !== undefined) {
    throw runError(
      `Check runner killed the run after ${String(transcript.timedOutAfterMs)}ms without an exit.`,
      transcript,
    );
  }
  if (transcript.signal !== null) {
    throw runError(`Check runner terminated from signal ${transcript.signal}.`, transcript);
  }
  if (transcript.exitCode === null) {
    throw runError("Check runner terminated without an exit code.", transcript);
  }
  if (
    transcript.exitCode !== 0 &&
    transcript.exitCode !== 1 &&
    transcript.exitCode !== 2 &&
    transcript.exitCode !== 3
  ) {
    throw runError(
      `Check runner returned unsupported exit code ${String(transcript.exitCode)}.`,
      transcript,
    );
  }
  return transcript.exitCode;
}

const TRANSCRIPT_LIMIT = 2000;

function runError(message: string, transcript: RunTranscript): Error {
  return new Error(
    [
      message,
      `  exit code: ${describeExit(transcript)}`,
      `  stdout: ${describeStream(transcript.stdout)}`,
      `  stderr: ${describeStream(transcript.stderr)}`,
    ].join("\n"),
  );
}

function describeExit(transcript: RunTranscript): string {
  if (transcript.signal !== null) {
    return `signal ${transcript.signal}`;
  }
  return transcript.exitCode === null ? "<missing>" : String(transcript.exitCode);
}

function describeStream(value: string): string {
  if (value === "") {
    return "<empty>";
  }
  const trimmed = value.length > TRANSCRIPT_LIMIT ? value.slice(0, TRANSCRIPT_LIMIT) : value;
  const suffix = value.length > TRANSCRIPT_LIMIT ? "… (truncated)" : "";
  return `${trimmed.replaceAll("\n", "\n    ")}${suffix}`;
}

/** Replaces a seed's machine-specific paths with stable labels, longest path first. */
export function createNormalizer(seed: TestSeed): (value: string) => string {
  const replacements: ReadonlyArray<readonly [string, string]> = [
    [seed.homeDir, "<HOME>"],
    [seed.pathDir, "<PATH>"],
    [seed.workspaceDir, "<WORKSPACE>"],
    [dirname(seed.homeDir), "<SEED>"],
  ];
  const ordered = [...replacements].sort((left, right) => right[0].length - left[0].length);

  return (value) => {
    let normalized = value;
    for (const [path, label] of ordered) {
      normalized = normalized.replaceAll(path, label);
    }
    return normalized;
  };
}
