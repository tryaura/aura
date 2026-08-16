import { dirname, join } from "node:path";

import {
  defineAdapter,
  detectExecutable,
  SHARED_INSTRUCTIONS_TEMPLATE_TOKEN,
  type AdapterFileSpec,
  type AdapterSourceFile,
  type Environment,
  type JsonObject,
} from "@tryaura/aura-sdk";

import {
  CLAUDE_CODE_ADAPTER_ID,
  CLAUDE_CODE_SOURCE_IDS as SOURCE_IDS,
  CLAUDE_PERMISSIONS_KEY,
} from "./contract.js";
import { parseInstructionFile } from "./instructions.js";
import { parseMcpServers } from "./mcp.js";
import { parsePermissionSettings } from "./settings.js";

/** Path segments {@link claudeFiles} appends to the home directory for the instruction file. */
const GLOBAL_INSTRUCTIONS_SEGMENTS = Object.freeze([".claude", "CLAUDE.md"]);

export const claudeCodeAdapter = defineAdapter({
  detect: (environment) =>
    detectExecutable(environment, { authenticationArgs: ["auth", "status"], binaryName: "claude" }),
  displayName: "Claude Code",
  files: claudeFiles,
  id: CLAUDE_CODE_ADAPTER_ID,
  installHint: "Run `claude update`, or reinstall Claude Code from https://claude.ai/install.",
  parse: ({ files }) => {
    const instructions = files.get(SOURCE_IDS.instructions);
    const mcp = files.get(SOURCE_IDS.mcp);

    return {
      instructionFiles:
        instructions?.content === undefined
          ? []
          : [parseInstructionFile(instructions, homeDirOf(instructions.spec.path))],
      mcpServers: mcp?.content === undefined ? [] : parseMcpServers(mcp),
      metadata: permissionMetadata(
        files.get(SOURCE_IDS.settingsGlobal),
        files.get(SOURCE_IDS.settingsProject),
      ),
      skills: [],
    };
  },
  sharedLink: {
    entryPath: "~/.claude/CLAUDE.md",
    kind: "import-line",
    lineTemplate: `@${SHARED_INSTRUCTIONS_TEMPLATE_TOKEN}`,
  },
  supportedRange: ">=2.1.0 <3.0.0",
});

function permissionMetadata(
  globalSettings: AdapterSourceFile | undefined,
  projectSettings: AdapterSourceFile | undefined,
): JsonObject | undefined {
  const summaries: Record<string, JsonObject> = {};
  if (globalSettings !== undefined) {
    const summary = parsePermissionSettings(globalSettings);
    if (summary !== undefined) {
      summaries["global"] = summary;
    }
  }
  if (projectSettings !== undefined) {
    const summary = parsePermissionSettings(projectSettings);
    if (summary !== undefined) {
      summaries["project"] = summary;
    }
  }
  return Object.keys(summaries).length === 0 ? undefined : { [CLAUDE_PERMISSIONS_KEY]: summaries };
}

/**
 * Declares the global configuration Claude Code keeps under the home directory.
 *
 * Global scope only. Project state — `./CLAUDE.md`, `.claude/CLAUDE.md`, `.mcp.json`, and the
 * per-directory servers under `projects` in `~/.claude.json` — is not read yet, so a workspace's
 * own configuration does not appear in the model.
 *
 * Permission settings are the narrow exception: ENV-004 needs their effective default mode, but
 * the model records only that mode and rule counts rather than permission entries.
 */
function claudeFiles(environment: Environment): readonly AdapterFileSpec[] {
  return [
    {
      id: SOURCE_IDS.instructions,
      kind: "instructions",
      optional: true,
      path: join(environment.homeDir, ...GLOBAL_INSTRUCTIONS_SEGMENTS),
      scope: "global",
    },
    {
      id: SOURCE_IDS.mcp,
      kind: "mcp",
      optional: true,
      path: join(environment.homeDir, ".claude.json"),
      scope: "global",
    },
    {
      id: SOURCE_IDS.settingsGlobal,
      kind: "config",
      optional: true,
      path: join(environment.homeDir, ".claude", "settings.json"),
      scope: "global",
    },
    {
      id: SOURCE_IDS.settingsProject,
      kind: "config",
      optional: true,
      path: join(environment.cwd, ".claude", "settings.json"),
      scope: "project",
    },
  ];
}

/**
 * Recovers the home directory from the path {@link claudeFiles} built out of it.
 *
 * `parse` is pure and never receives an `Environment`, so this is where the home directory still
 * exists. Undoing the join beside the join itself keeps the two from drifting, and leaves the
 * instruction parser free of any assumption about where its document sits.
 */
function homeDirOf(instructionsPath: string): string {
  return GLOBAL_INSTRUCTIONS_SEGMENTS.reduce((path) => dirname(path), instructionsPath);
}
