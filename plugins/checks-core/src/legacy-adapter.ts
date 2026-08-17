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

interface InventoryInstructionFile {
  /**
   * Whether the format has been superseded by the one its application now reads.
   *
   * Only the superseded ones are something to consolidate, so this is what INS-004 reports on. The
   * rest are inventoried without being flagged: no adapter models them, and dropping them from the
   * workspace entirely would take them out of every other instruction check too.
   */
  readonly legacy: boolean;
  readonly segments: readonly string[];
  readonly tool: string;
}

const INVENTORY_FILES: readonly InventoryInstructionFile[] = Object.freeze([
  { legacy: true, segments: [".cursorrules"], tool: "cursor" },
  { legacy: true, segments: [".windsurfrules"], tool: "windsurf" },
  { legacy: true, segments: [".clinerules"], tool: "cline" },
  { legacy: true, segments: ["AMPCODE.md"], tool: "amp" },
  { legacy: true, segments: [".goosehints"], tool: "goose" },
  { legacy: false, segments: ["GEMINI.md"], tool: "gemini" },
  { legacy: false, segments: ["CRUSH.md"], tool: "crush" },
  { legacy: false, segments: ["WARP.md"], tool: "warp" },
  { legacy: false, segments: [".github", "copilot-instructions.md"], tool: "github-copilot" },
]);
const SCOPES: readonly Scope[] = Object.freeze(["global", "project"]);

export const legacyInstructionsAdapter = defineAdapter({
  detect: async () => ({ installed: true, version: "1.0.0" }),
  displayName: "Unmanaged instruction inventory",
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
 * Declares every inventoried filename at home, at the repository root, and at the invocation
 * directory.
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
  return INVENTORY_FILES.map((file) => ({
    id: `${sourceId(scope, file.tool)}${suffix}`,
    kind: "instructions",
    optional: true,
    path: join(base, ...file.segments),
    scope,
  }));
}

function toInstructionDocument(file: AdapterSourceFile): readonly InstructionDocument[] {
  const entry = entryForSourceId(file.spec.id);
  if (file.content === undefined || entry === undefined) {
    return [];
  }

  return [
    {
      content: file.content,
      links: [],
      metadata: { legacy: entry.legacy, tool: entry.tool },
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
function entryForSourceId(id: string): InventoryInstructionFile | undefined {
  const [prefix, scope, tool] = id.split(".");
  if (prefix !== LEGACY_INSTRUCTIONS_ADAPTER_ID || !isScope(scope)) {
    return undefined;
  }
  return INVENTORY_FILES.find((file) => file.tool === tool);
}

function isScope(value: string | undefined): value is Scope {
  return SCOPES.some((scope) => scope === value);
}
