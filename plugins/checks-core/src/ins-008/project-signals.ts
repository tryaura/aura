import { dirname } from "node:path";

import {
  maskMarkdownCode,
  type InstructionDocument,
  type JsonObject,
  type RepositoryPackageManifest,
} from "@tryaura/aura-sdk";

import { canonicalInstructionDocuments } from "../instruction-documents.js";

const COMMON_SCRIPT_NAMES = new Set([
  "build",
  "dev",
  "format",
  "lint",
  "start",
  "test",
  "typecheck",
]);
/**
 * A path-like token in prose, captured without its leading punctuation or optional `./`.
 *
 * The token becomes a signal only when it names or descends from a package directory observed in
 * this repository. That grounding keeps generic `packages/example` advice quiet elsewhere while
 * supporting layouts such as `services/` and `libs/` without hardcoding any of them.
 */
const PATH_TOKEN_PATTERN =
  /(?:^|[\s("'`])(?:\.\/)?((?:[A-Za-z0-9._-]*[A-Za-z0-9_-])(?:\/(?:[A-Za-z0-9._-]*[A-Za-z0-9_-]))+)/gu;
/** Maximum structured evidence retained for one global instruction file. */
const MAX_REPORTED_SIGNALS = 100;
/**
 * Names distinctive enough that prose is unlikely to contain them by accident.
 *
 * A scope, a separator, or a dot makes a name recognisably a package. A bare lowercase word does
 * not — this repository's own root manifest is named `aura`, and matching that would report every
 * global instruction file that used the word in a sentence.
 */
const DISTINCTIVE_PACKAGE_NAME_PATTERN = /^@[^/]+\/.+|[-_.]/u;

type ProjectSignalKind = "package" | "path" | "script";

interface ProjectSignal extends JsonObject {
  readonly kind: ProjectSignalKind;
  readonly line: number;
}

export interface ProjectSignalReport {
  readonly omittedSignals: number;
  readonly signals: readonly ProjectSignal[];
}

/** Finds global guidance whose vocabulary binds it to the current repository. */
export function projectSpecificSignals(
  documents: readonly InstructionDocument[],
  manifests: readonly RepositoryPackageManifest[],
): readonly (readonly [InstructionDocument, ProjectSignalReport])[] {
  const packagePatterns = [
    ...new Set(
      manifests
        .flatMap((manifest) => (manifest.name === undefined ? [] : [manifest.name]))
        .filter((name) => DISTINCTIVE_PACKAGE_NAME_PATTERN.test(name)),
    ),
  ]
    .sort()
    .map(tokenPattern);
  const scriptPatterns = [
    ...new Set(
      manifests
        .flatMap((manifest) => manifest.scripts)
        .filter((script) => !COMMON_SCRIPT_NAMES.has(script)),
    ),
  ]
    .sort()
    .map(scriptPattern);
  const packageDirectories = new Set(
    manifests
      .map((manifest) => dirname(manifest.path))
      .filter((path) => path !== "." && path !== "/"),
  );

  return canonicalInstructionDocuments(documents, "global").flatMap((document) => {
    const report = signalsForDocument(
      document,
      packageDirectories,
      packagePatterns,
      scriptPatterns,
    );
    if (report.signals.length === 0) {
      return [];
    }
    const entry: readonly [InstructionDocument, ProjectSignalReport] = [document, report];
    return [entry];
  });
}

function signalsForDocument(
  document: InstructionDocument,
  packageDirectories: ReadonlySet<string>,
  packagePatterns: readonly RegExp[],
  scriptPatterns: readonly RegExp[],
): ProjectSignalReport {
  const signals: ProjectSignal[] = [];
  let omittedSignals = 0;
  // Masked for the same reason INS-003 and INS-005 mask: a fenced directory listing or a sample
  // command is an illustration, not guidance this repository's layout is baked into.
  const lines = maskMarkdownCode(document.content).split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (hasRepositoryPath(line, packageDirectories)) {
      omittedSignals += appendSignal(signals, { kind: "path", line: lineNumber });
    }
    if (packagePatterns.some((pattern) => pattern.test(line))) {
      omittedSignals += appendSignal(signals, { kind: "package", line: lineNumber });
    }
    if (scriptPatterns.some((pattern) => pattern.test(line))) {
      omittedSignals += appendSignal(signals, { kind: "script", line: lineNumber });
    }
  }
  return { omittedSignals, signals };
}

function appendSignal(signals: ProjectSignal[], signal: ProjectSignal): 0 | 1 {
  if (signals.length >= MAX_REPORTED_SIGNALS) {
    return 1;
  }
  signals.push(signal);
  return 0;
}

function hasRepositoryPath(line: string, packageDirectories: ReadonlySet<string>): boolean {
  if (packageDirectories.size === 0) {
    return false;
  }
  for (const match of line.matchAll(PATH_TOKEN_PATTERN)) {
    let candidate = match[1];
    while (candidate !== undefined && candidate !== "." && candidate !== "/") {
      if (packageDirectories.has(candidate)) {
        return true;
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        break;
      }
      candidate = parent;
    }
  }
  return false;
}

/** Compiled once per scan: a manifest name is tested against every line of every global file. */
function tokenPattern(value: string): RegExp {
  return new RegExp(`(?:^|[\\s("'\`])${escapeRegex(value)}(?=$|[\\s,.;:)"'\`])`, "u");
}

/**
 * Matches a script named in prose, ending where a script name can no longer continue.
 *
 * Sentence punctuation and shell delimiters end a name; `:` and `-` do not, because `verify:ci` and
 * `verify-all` are script names in their own right and matching `verify` inside them would report a
 * script this repository may not have.
 */
function scriptPattern(script: string): RegExp {
  return new RegExp(
    `\\b(?:npm\\s+run|pnpm(?:\\s+run)?|yarn(?:\\s+run)?|bun\\s+run)\\s+${escapeRegex(script)}(?=$|[\\s,.;!?)"';&|\`])`,
    "u",
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
