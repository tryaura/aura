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
 * Workspace directories that name a repository layout rather than a universal convention.
 *
 * `src/` is deliberately absent: "put helpers in src/lib" is advice a developer can carry between
 * repositories, so matching it would file ordinary global guidance as repository-specific.
 */
const REPOSITORY_PATH_PATTERN =
  /(?:^|[\s("'`])(?:\.\/)?(?:apps|distros|packages|plugins)\/[A-Za-z0-9._/-]+/u;
/**
 * Names distinctive enough that prose is unlikely to contain them by accident.
 *
 * A scope, a separator, or a dot makes a name recognisably a package. A bare lowercase word does
 * not — this repository's own root manifest is named `aura`, and matching that would report every
 * global instruction file that used the word in a sentence.
 */
const DISTINCTIVE_PACKAGE_NAME_PATTERN = /^@[^/]+\/.+|[-_.]/u;

type ProjectSignalKind = "package" | "path" | "script";

export interface ProjectSignal extends JsonObject {
  readonly kind: ProjectSignalKind;
  readonly line: number;
}

/** Finds global guidance whose vocabulary binds it to the current repository. */
export function projectSpecificSignals(
  documents: readonly InstructionDocument[],
  manifests: readonly RepositoryPackageManifest[],
): readonly (readonly [InstructionDocument, readonly ProjectSignal[]])[] {
  const packagePatterns = manifests
    .flatMap((manifest) => (manifest.name === undefined ? [] : [manifest.name]))
    .filter((name) => DISTINCTIVE_PACKAGE_NAME_PATTERN.test(name))
    .filter(uniqueStrings)
    .sort()
    .map(tokenPattern);
  const scriptPatterns = manifests
    .flatMap((manifest) => manifest.scripts)
    .filter((script) => !COMMON_SCRIPT_NAMES.has(script))
    .filter(uniqueStrings)
    .sort()
    .map(scriptPattern);

  return canonicalInstructionDocuments(documents, "global").flatMap((document) => {
    const signals = signalsForDocument(document, packagePatterns, scriptPatterns);
    if (signals.length === 0) {
      return [];
    }
    const entry: readonly [InstructionDocument, readonly ProjectSignal[]] = [document, signals];
    return [entry];
  });
}

function signalsForDocument(
  document: InstructionDocument,
  packagePatterns: readonly RegExp[],
  scriptPatterns: readonly RegExp[],
): readonly ProjectSignal[] {
  const signals: ProjectSignal[] = [];
  // Masked for the same reason INS-003 and INS-005 mask: a fenced directory listing or a sample
  // command is an illustration, not guidance this repository's layout is baked into.
  const lines = maskMarkdownCode(document.content).split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (REPOSITORY_PATH_PATTERN.test(line)) {
      signals.push({ kind: "path", line: lineNumber });
    }
    if (packagePatterns.some((pattern) => pattern.test(line))) {
      signals.push({ kind: "package", line: lineNumber });
    }
    if (scriptPatterns.some((pattern) => pattern.test(line))) {
      signals.push({ kind: "script", line: lineNumber });
    }
  }
  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = `${signal.kind}\0${String(signal.line)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** Compiled once per scan: a manifest name is tested against every line of every global file. */
function tokenPattern(value: string): RegExp {
  return new RegExp(`(?:^|[\\s("'\`])${escapeRegex(value)}(?=$|[\\s,.;:)"'\`])`, "u");
}

function scriptPattern(script: string): RegExp {
  return new RegExp(
    `\\b(?:npm\\s+run|pnpm(?:\\s+run)?|yarn(?:\\s+run)?|bun\\s+run)\\s+${escapeRegex(script)}(?=$|[\\s;&|\`])`,
    "u",
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function uniqueStrings(value: string, index: number, values: readonly string[]): boolean {
  return values.indexOf(value) === index;
}
