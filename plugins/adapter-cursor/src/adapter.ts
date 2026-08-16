import { join } from "node:path";

import {
  defineAdapter,
  detectExecutable,
  SHARED_INSTRUCTIONS_TEMPLATE_TOKEN,
  type AdapterDetection,
  type AdapterFileMap,
  type AdapterFileSpec,
  type AdapterSourceFile,
  type Environment,
} from "@tryaura/aura-sdk";

import { parseMcpServers } from "./mcp.js";
import { parseRuleFile } from "./rules.js";

const SOURCE_IDS = Object.freeze({
  agents: "cursor.rules.project.agents",
  aura: "cursor.rules.project/aura-owned",
  legacyRules: "cursor.rules.project.legacy",
  mcpGlobal: "cursor.mcp.global",
  mcpProject: "cursor.mcp.project",
  rulesProject: "cursor.rules.project",
});

export const cursorAdapter = defineAdapter({
  /**
   * Cursor exposes no command that reports credential state, so detection stops at `--version`.
   *
   * On Windows the installer puts a `cursor.cmd` shim into `resources\app\bin` and adds that
   * directory to the search path; there is no `cursor.exe` beside it, so the shim is what gets
   * probed.
   */
  detect: (environment) =>
    detectExecutable(environment, { binaryName: "cursor", windowsBinaryName: "cursor.cmd" }),
  displayName: "Cursor",
  files: cursorFiles,
  id: "cursor",
  installHint:
    "Use Help > Check for Updates in Cursor, or install the latest release from https://cursor.com/downloads.",
  parse: ({ files, homeDir }) => ({
    instructionFiles: [...files.values()]
      .filter(isInstructionSource)
      .map((file) => parseRuleFile(file, homeDir)),
    mcpServers: [SOURCE_IDS.mcpGlobal, SOURCE_IDS.mcpProject].flatMap((id) => {
      const file = files.get(id);
      return file?.content === undefined ? [] : parseMcpServers(file);
    }),
    skills: [],
  }),
  sharedLink: {
    entryPath: "./.cursor/rules/aura.mdc",
    kind: "native-copy",
    lineTemplate: [
      "---",
      "alwaysApply: true",
      "---",
      "",
      `@file ${SHARED_INSTRUCTIONS_TEMPLATE_TOKEN}`,
      "",
    ].join("\n"),
  },
  supportedRange: ">=0.45.0 <4.0.0",
});

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
function cursorFiles(
  environment: Environment,
  _detection: AdapterDetection,
  files: AdapterFileMap,
): readonly AdapterFileSpec[] {
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
      id: SOURCE_IDS.aura,
      kind: "instructions",
      optional: true,
      path: join(environment.cwd, ".cursor", "rules", "aura.mdc"),
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
      if (file.spec.id === SOURCE_IDS.rulesProject && entry === "aura.mdc") {
        continue;
      }
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
