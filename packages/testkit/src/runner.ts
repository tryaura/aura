import { dirname } from "node:path";
import { PassThrough, Readable } from "node:stream";

import { runCli } from "@tryaura/aura-cli";
import type {
  Finding,
  FindingLocation,
  JsonObject,
  JsonValue,
  Scope,
  Severity,
} from "@tryaura/aura-sdk";

import { captureFilesystem, diffFilesystem } from "./filesystem.js";
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
  if (capturedExitCode !== exitCode) {
    throw new Error("CLI returned an exit code different from the captured process exit code.");
  }

  const normalize = createNormalizer(options.seed);
  const normalizedStdout = normalize(stdout.read());
  const normalizedStderr = normalize(stderr.read());
  const after = await captureFilesystem(options.seed);

  return Object.freeze({
    diffs: diffFilesystem(before, after, normalize),
    exitCode,
    findings: parseFindings(normalizedStdout),
    stderr: normalizedStderr,
    stdout: normalizedStdout,
  });
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

function parseFindings(stdout: string): readonly Finding[] {
  let document: unknown;
  try {
    document = JSON.parse(stdout);
  } catch {
    throw new Error("Check runner expected one JSON report on stdout.");
  }
  if (!isRecord(document) || !Array.isArray(document["findings"])) {
    throw new Error("Check runner received a JSON report without a findings array.");
  }

  const findings: Finding[] = [];
  for (const value of document["findings"]) {
    const finding = parseFinding(value);
    if (finding === undefined) {
      throw new Error("Check runner received an invalid finding in its JSON report.");
    }
    findings.push(Object.freeze(finding));
  }
  return Object.freeze(findings);
}

function parseFinding(value: unknown): Finding | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const required = parseRequiredFinding(value);
  const optional = parseOptionalFinding(value);
  if (required === undefined || optional === false) {
    return undefined;
  }

  return { ...required, ...optional };
}

type RequiredFinding = Pick<Finding, "checkId" | "id" | "message" | "scope" | "severity">;

function parseRequiredFinding(value: Record<string, unknown>): RequiredFinding | undefined {
  const checkId = value["checkId"];
  const id = value["id"];
  const message = value["message"];
  const scope = value["scope"];
  const severity = value["severity"];
  if (
    typeof checkId !== "string" ||
    typeof id !== "string" ||
    typeof message !== "string" ||
    !isScope(scope) ||
    !isSeverity(severity)
  ) {
    return undefined;
  }

  return { checkId, id, message, scope, severity };
}

type OptionalFinding = Partial<Pick<Finding, "details" | "locations" | "metadata">>;

function parseOptionalFinding(value: Record<string, unknown>): OptionalFinding | false {
  const details = optionalString(value["details"]);
  const locations = optionalLocations(value["locations"]);
  const metadata = optionalJsonObject(value["metadata"]);
  if (details === false || locations === false || metadata === false) {
    return false;
  }

  return {
    ...(details === undefined ? {} : { details }),
    ...(locations === undefined ? {} : { locations }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function optionalString(value: unknown): string | undefined | false {
  return value === undefined || typeof value === "string" ? value : false;
}

function optionalLocations(value: unknown): readonly FindingLocation[] | undefined | false {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every(isFindingLocation)) {
    return false;
  }
  return value.map((location) => Object.freeze(copyLocation(location)));
}

function copyLocation(location: FindingLocation): FindingLocation {
  return {
    path: location.path,
    ...(location.column === undefined ? {} : { column: location.column }),
    ...(location.line === undefined ? {} : { line: location.line }),
  };
}

function isFindingLocation(value: unknown): value is FindingLocation {
  return (
    isRecord(value) &&
    typeof value["path"] === "string" &&
    isOptionalPositiveInteger(value["column"]) &&
    isOptionalPositiveInteger(value["line"])
  );
}

function optionalJsonObject(value: unknown): JsonObject | undefined | false {
  if (value === undefined) {
    return undefined;
  }
  return isJsonObject(value) ? value : false;
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string" ||
    (Array.isArray(value) && value.every(isJsonValue)) ||
    isJsonObject(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalPositiveInteger(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isInteger(value) && value > 0);
}

function isScope(value: unknown): value is Scope {
  return value === "global" || value === "project";
}

function isSeverity(value: unknown): value is Severity {
  return value === "error" || value === "info" || value === "warn";
}
