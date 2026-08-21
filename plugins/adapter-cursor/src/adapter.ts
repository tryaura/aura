import { join } from "node:path";

import {
  defineAdapter,
  type AdapterFileMap,
  type AdapterFileSpec,
  type AdapterFilesInput,
  type AdapterProblem,
  type AdapterSourceFile,
} from "@tryaura/aura-sdk";

import { CURSOR_ADAPTER_ID, CURSOR_SOURCE_IDS as SOURCE_IDS } from "./contract.js";
import { detectCursor } from "./detect.js";
import { parseMcpServers, transformMcpSecrets, writeMcpServers } from "./mcp.js";
import { parseRuleFile } from "./rules.js";

export const cursorAdapter = defineAdapter({
  capabilities: {
    // Rules and AGENTS.md are roots; `@` references pull further files in. Which rules are roots
    // at all is per-document knowledge, published as `isConditionalCursorRule` in the contract.
    instructions: {
      globalSharedLink: "not-applicable",
      importStyle: "at-import",
      loading: "import-graph",
    },
  },
  detect: detectCursor,
  detectionScope: "the cursor shell command on PATH (the editor itself is not checked)",
  displayName: "Cursor",
  files: cursorFiles,
  id: CURSOR_ADAPTER_ID,
  installHint:
    "Use Help > Check for Updates in Cursor, or install the latest release from https://cursor.com/downloads.",
  mcpWrite: writeMcpServers,
  mcpSecrets: transformMcpSecrets,
  parse: ({ files, homeDir }) => {
    const mcpFiles = [SOURCE_IDS.mcpGlobal, SOURCE_IDS.mcpProject].flatMap((id) => {
      const file = files.get(id);
      return file === undefined ? [] : [{ config: parseMcpServers(file), file }];
    });

    return {
      instructionFiles: [...files.values()]
        .filter(isInstructionSource)
        .map((file) => parseRuleFile(file, homeDir)),
      mcpServers: mcpFiles.flatMap(({ config }) => config.servers),
      mcpSecretSightings: mcpFiles.flatMap(({ config }) => config.secretSightings ?? []),
      problems: mcpFiles.flatMap(({ config, file }) => unusableMcp(file, config.malformed)),
      skills: [],
      unusableMcpServers: mcpFiles.flatMap(({ config }) => config.unusable),
    };
  },
  // No `sharedLink`. The explicit capability above says why the global link
  // is not applicable: Cursor keeps User Rules inside its own settings, so there is no home entry
  // to write. Earlier versions borrowed a project path for that global link, making a home-scoped
  // check demand a file in whichever repository the user happened to run it from. At project scope
  // there is nothing to write either: Cursor reads the root AGENTS.md directly.
  //
  // Cursor's MCP and rules formats have been stable across major releases, so a wide verified
  // range costs little. Codex's adapter takes the opposite bet: its configuration format churns
  // per minor release, so it pins a narrow verified window instead.
  supportedRange: ">=0.45.0 <4.0.0",
});

/**
 * Reports MCP configuration that is present but unreadable.
 *
 * The failure this describes is invisible from the outside: Cursor refuses the whole file, so
 * every server in it stops working at once while the file still sits there looking configured.
 * Silence is the wrong answer from a tool whose job is explaining that.
 */
function unusableMcp(file: AdapterSourceFile, malformed: boolean): readonly AdapterProblem[] {
  if (!malformed) {
    return [];
  }

  return [
    {
      message: `Cursor's MCP configuration at ${file.spec.path} is not a valid JSON object, so none of the servers it declares are loading — in Cursor either. Fix the file to restore them.`,
      sourceId: file.spec.id,
    },
  ];
}

/**
 * Declares Cursor's configuration, expanding the project rules directory to a fixed point.
 *
 * Cursor permits folders inside `.cursor/rules`, so every listed child is inspected: its read
 * result is the only way an adapter can distinguish another directory from a file. Parsing still
 * accepts only `.mdc` files; unrelated files under the directory never enter the model.
 *
 * Global scope declares only `~/.cursor/mcp.json`. User Rules live inside Cursor's application
 * settings rather than any file on disk, so there is nothing global to read for instructions.
 * `AGENTS.md` is read at the project root; Cursor also honors nested ones in subdirectories,
 * which would take a walk of the whole tree that no adapter should ask for.
 */
function cursorFiles({ environment, files }: AdapterFilesInput): readonly AdapterFileSpec[] {
  return [
    {
      id: SOURCE_IDS.rulesProject,
      kind: "instructions",
      optional: true,
      path: join(environment.cwd, ".cursor", "rules"),
      scope: "project",
    },
    {
      id: SOURCE_IDS.legacyRules,
      kind: "instructions",
      optional: true,
      path: join(environment.cwd, ".cursorrules"),
      scope: "project",
    },
    {
      id: SOURCE_IDS.agents,
      kind: "instructions",
      optional: true,
      path: join(environment.cwd, "AGENTS.md"),
      scope: "project",
    },
    {
      id: SOURCE_IDS.mcpGlobal,
      kind: "mcp",
      optional: true,
      path: join(environment.homeDir, ".cursor", "mcp.json"),
      scope: "global",
    },
    {
      id: SOURCE_IDS.mcpProject,
      kind: "mcp",
      optional: true,
      path: join(environment.cwd, ".cursor", "mcp.json"),
      scope: "project",
    },
    ...discoveredRuleSpecs(files),
  ];
}

function discoveredRuleSpecs(files: AdapterFileMap): readonly AdapterFileSpec[] {
  const specs: AdapterFileSpec[] = [];

  for (const file of files.values()) {
    if (!isRuleSourceId(file.spec.id) || file.entries === undefined) {
      continue;
    }
    for (const entry of file.entries) {
      specs.push({
        id: `${file.spec.id}/${encodeURIComponent(entry)}`,
        kind: "instructions",
        optional: true,
        path: join(file.spec.path, entry),
        scope: "project",
      });
    }
  }

  return specs;
}

function isInstructionSource(file: AdapterSourceFile): boolean {
  if (file.content === undefined) {
    return false;
  }
  if (file.spec.id === SOURCE_IDS.legacyRules || file.spec.id === SOURCE_IDS.agents) {
    return true;
  }
  return isRuleSourceId(file.spec.id) && file.spec.path.endsWith(".mdc");
}

function isRuleSourceId(id: string): boolean {
  return id === SOURCE_IDS.rulesProject || id.startsWith(`${SOURCE_IDS.rulesProject}/`);
}
