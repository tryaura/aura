import { dirname } from "node:path";
import { PassThrough, Readable } from "node:stream";

import { runCli } from "@tryaura/aura-cli";

import { captureFilesystem, diffFilesystem } from "./filesystem.js";
import { parseReport } from "./report.js";
import type { RunCheckOptions, TestRunResult, TestSeed } from "./types.js";

interface TextCapture {
  readonly read: () => string;
  readonly stream: PassThrough;
}

/** Runs `check --json` without reading process state and returns snapshot-ready output. */
export async function runCheck(options: RunCheckOptions): Promise<TestRunResult> {
  const before = await captureFilesystem(options.seed);
  const stderr = createTextCapture();
  const stdout = createTextCapture();
  let capturedExitCode: number | undefined;

  const exitCode = await runCli(options.distro, {
    argv: ["check", "--json", ...(options.args ?? [])],
    colorDepth: 0,
    cwd: options.seed.workspaceDir,
    environmentVariables: { PATH: options.seed.pathDir },
    homeDir: options.seed.homeDir,
    setExitCode: (code) => {
      capturedExitCode = code;
    },
    stderr: stderr.stream,
    stdin: Readable.from([]),
    stdout: stdout.stream,
  });

  const normalize = createNormalizer(options.seed);
  const normalizedStdout = normalize(stdout.read());
  const normalizedStderr = normalize(stderr.read());
  const transcript: RunTranscript = {
    exitCode,
    stderr: normalizedStderr,
    stdout: normalizedStdout,
  };
  if (capturedExitCode !== exitCode) {
    throw runError("Check runner saw two disagreeing exit codes for one run.", transcript);
  }

  const report = parseReport(normalizedStdout, (message) => runError(message, transcript));
  const after = await captureFilesystem(options.seed);

  return Object.freeze({
    diffs: diffFilesystem(before, after, normalize),
    exitCode,
    findings: report.findings,
    report,
    stderr: normalizedStderr,
    stdout: normalizedStdout,
  });
}

interface RunTranscript {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

const TRANSCRIPT_LIMIT = 2000;

/**
 * Builds a failure that carries the run it is about.
 *
 * Everything that explains a failed run — the exit code, and the stderr the CLI writes its own
 * errors to — is already captured by the time parsing can fail. Reporting the failure without them
 * is what turns a mistyped flag into an unexplained "expected one JSON report".
 */
function runError(message: string, transcript: RunTranscript): Error {
  return new Error(
    [
      message,
      `  exit code: ${String(transcript.exitCode)}`,
      `  stdout: ${describeStream(transcript.stdout)}`,
      `  stderr: ${describeStream(transcript.stderr)}`,
    ].join("\n"),
  );
}

function describeStream(value: string): string {
  if (value === "") {
    return "<empty>";
  }
  const trimmed = value.length > TRANSCRIPT_LIMIT ? value.slice(0, TRANSCRIPT_LIMIT) : value;
  const suffix = value.length > TRANSCRIPT_LIMIT ? "… (truncated)" : "";
  return `${trimmed.replaceAll("\n", "\n    ")}${suffix}`;
}

function createTextCapture(): TextCapture {
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    chunks.push(chunk);
  });
  return { read: () => chunks.join(""), stream };
}

function createNormalizer(seed: TestSeed): (value: string) => string {
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
