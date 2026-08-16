import { join, resolve as resolvePath } from "node:path";

import {
  defineAdapter,
  type AdapterFileMap,
  type AdapterFileSpec,
  type AdapterSourceFile,
  type Environment,
  type InstructionDocument,
  type Scope,
} from "@tryaura/aura-sdk";

export const LEGACY_INSTRUCTIONS_ADAPTER_ID = "legacy-instructions";

interface LegacyInstructionFile {
  readonly segments: readonly string[];
  readonly tool: string;
}

const LEGACY_FILES: readonly LegacyInstructionFile[] = Object.freeze([
  { segments: [".cursorrules"], tool: "cursor" },
  { segments: [".windsurfrules"], tool: "windsurf" },
  { segments: [".clinerules"], tool: "cline" },
  { segments: ["GEMINI.md"], tool: "gemini" },
  { segments: ["CRUSH.md"], tool: "crush" },
  { segments: ["WARP.md"], tool: "warp" },
  { segments: ["AMPCODE.md"], tool: "amp" },
  { segments: [".goosehints"], tool: "goose" },
  { segments: [".github", "copilot-instructions.md"], tool: "github-copilot" },
]);
const SCOPES: readonly Scope[] = Object.freeze(["global", "project"]);

export const legacyInstructionsAdapter = defineAdapter({
  detect: async () => ({ installed: true, version: "1.0.0" }),
  displayName: "Legacy instruction inventory",
  files: legacyFiles,
  id: LEGACY_INSTRUCTIONS_ADAPTER_ID,
  parse: ({ files }) => ({
    instructionFiles: [...files.values()].flatMap(toInstructionDocument),
    mcpServers: [],
    skills: [],
  }),
  supportedRange: ">=1 <2",
  synthetic: true,
});

/**
 * Declares every legacy filename at home, at the repository root, and at the invocation directory.
 *
 * The last of those is not redundant: adapters mirror the application they model, and the ones
 * that read a project file read it beside the directory Aura was invoked from rather than at the
 * repository root. A file left in a subpackage is exactly the forgotten kind this inventory exists
 * to surface, so both bases are searched and the overlap is dropped rather than the difference.
 */
function legacyFiles(
  environment: Environment,
  _detection: { readonly installed: boolean },
  _files: AdapterFileMap,
  projectRoot: string | undefined,
): readonly AdapterFileSpec[] {
  const projectBases = [
    ...new Set([projectRoot, environment.cwd].filter(isBase).map((base) => resolvePath(base))),
  ];
  return [
    ...specsForScope(environment.homeDir, "global", ""),
    ...projectBases.flatMap((base, index) =>
      specsForScope(base, "project", index === 0 ? "" : `.${String(index)}`),
    ),
  ];
}

function isBase(base: string | undefined): base is string {
  return base !== undefined;
}

function specsForScope(base: string, scope: Scope, suffix: string): readonly AdapterFileSpec[] {
  return LEGACY_FILES.map((file) => ({
    id: `${sourceId(scope, file.tool)}${suffix}`,
    kind: "instructions",
    optional: true,
    path: join(base, ...file.segments),
    scope,
  }));
}

function toInstructionDocument(file: AdapterSourceFile): readonly InstructionDocument[] {
  const tool = toolForSourceId(file.spec.id);
  if (file.content === undefined || tool === undefined) {
    return [];
  }

  return [
    {
      content: file.content,
      links: [],
      metadata: { legacy: true, tool },
      path: file.spec.path,
      scope: file.spec.scope,
      sourceId: file.spec.id,
    },
  ];
}

function sourceId(scope: Scope, tool: string): string {
  return `${LEGACY_INSTRUCTIONS_ADAPTER_ID}.${scope}.${tool}`;
}

/** Reads back {@link sourceId}, ignoring the index {@link legacyFiles} appends per project base. */
function toolForSourceId(id: string): string | undefined {
  const [prefix, scope, tool] = id.split(".");
  if (prefix !== LEGACY_INSTRUCTIONS_ADAPTER_ID || !isScope(scope)) {
    return undefined;
  }
  return LEGACY_FILES.find((file) => file.tool === tool)?.tool;
}

function isScope(value: string | undefined): value is Scope {
  return SCOPES.some((scope) => scope === value);
}
