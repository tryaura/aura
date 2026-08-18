import { join } from "node:path";

import {
  defineAdapter,
  detectExecutable,
  parseInstalledSkills,
  SHARED_INSTRUCTIONS_TEMPLATE_TOKEN,
  skillDirectorySpecs,
  type AdapterFileSpec,
  type AdapterFilesInput,
  type AdapterProblem,
  type AdapterSkillDirectory,
  type AdapterSourceFile,
  type JsonObject,
} from "@tryaura/aura-sdk";

import {
  CLAUDE_CODE_ADAPTER_ID,
  CLAUDE_CODE_SOURCE_IDS as SOURCE_IDS,
  CLAUDE_PERMISSIONS_KEY,
} from "./contract.js";
import { parseInstructionFile } from "./instructions.js";
import {
  parseGlobalMcpServers,
  parseMcpServers,
  transformMcpSecrets,
  writeMcpServers,
} from "./mcp.js";
import { parsePermissionSettings } from "./settings.js";

/** Path segments {@link claudeFiles} appends to the home directory for the global instructions. */
const GLOBAL_INSTRUCTIONS_SEGMENTS = Object.freeze([".claude", "CLAUDE.md"]);
const SKILL_DIRECTORIES: readonly AdapterSkillDirectory[] = Object.freeze([
  { entryPath: "~/.claude/skills", id: SOURCE_IDS.skillsGlobal },
  { entryPath: "./.claude/skills", id: SOURCE_IDS.skillsProject },
]);

export const claudeCodeAdapter = defineAdapter({
  capabilities: {
    instructions: { importDepthLimit: 5, importStyle: "at-import", loading: "import-graph" },
    skills: { directories: SKILL_DIRECTORIES },
  },
  detect: (environment) =>
    detectExecutable(environment, { authenticationArgs: ["auth", "status"], binaryName: "claude" }),
  detectionScope: "the claude CLI on PATH (the desktop app is not checked)",
  displayName: "Claude Code",
  files: claudeFiles,
  id: CLAUDE_CODE_ADAPTER_ID,
  installHint: "Run `claude update`, or reinstall Claude Code from https://claude.ai/install.",
  mcpWrite: writeMcpServers,
  mcpSecrets: transformMcpSecrets,
  parse: (input) => {
    const { cwd, files, homeDir } = input;
    const globalFile = files.get(SOURCE_IDS.mcp);
    const projectFile = files.get(SOURCE_IDS.mcpProject);
    const global =
      globalFile === undefined ? EMPTY_GLOBAL_MCP : parseGlobalMcpServers(globalFile, cwd);
    const project = projectFile === undefined ? EMPTY_MCP : parseMcpServers(projectFile);

    return {
      instructionFiles: [SOURCE_IDS.instructions, SOURCE_IDS.instructionsProject].flatMap((id) => {
        const file = files.get(id);
        return file?.content === undefined ? [] : [parseInstructionFile(file, homeDir)];
      }),
      // Ordered by specificity: what applies everywhere, what the repository ships, then what this
      // one directory was given. Nothing is collapsed — two scopes configuring the same name is
      // itself a finding, and a model that deduplicated could not report it.
      mcpServers: [...global.globalServers, ...project.servers, ...global.localServers],
      mcpSecretSightings: [...(global.secretSightings ?? []), ...(project.secretSightings ?? [])],
      unusableMcpServers: [...global.unusable, ...project.unusable],
      metadata: permissionMetadata({
        global: files.get(SOURCE_IDS.settingsGlobal),
        local: files.get(SOURCE_IDS.settingsLocal),
        project: files.get(SOURCE_IDS.settingsProject),
      }),
      problems: [
        ...unusableMcp(globalFile, global.malformed),
        ...unusableMcp(projectFile, project.malformed),
      ],
      skills: parseInstalledSkills(CLAUDE_CODE_ADAPTER_ID, input, SKILL_DIRECTORIES),
    };
  },
  projectSharedLink: {
    entryPath: "./CLAUDE.md",
    kind: "import-line",
    lineTemplate: `@${SHARED_INSTRUCTIONS_TEMPLATE_TOKEN}`,
  },
  sharedLink: {
    entryPath: "~/.claude/CLAUDE.md",
    kind: "import-line",
    lineTemplate: `@${SHARED_INSTRUCTIONS_TEMPLATE_TOKEN}`,
  },
  supportedRange: ">=2.1.0 <3.0.0",
});

/** What an absent file contributes, so `parse` reads the same whether or not one was found. */
const EMPTY_MCP = Object.freeze({
  malformed: false,
  secretSightings: undefined,
  servers: [],
  unusable: [],
});
const EMPTY_GLOBAL_MCP = Object.freeze({
  globalServers: [],
  localServers: [],
  malformed: false,
  secretSightings: undefined,
  unusable: [],
});

/**
 * Reports MCP configuration that is present but unreadable.
 *
 * The failure this describes is invisible from the outside: Claude Code refuses the whole file, so
 * every server in it stops working at once while the file still sits there looking configured.
 * Silence is the wrong answer from a tool whose job is explaining that.
 */
function unusableMcp(
  file: AdapterSourceFile | undefined,
  malformed: boolean,
): readonly AdapterProblem[] {
  if (file === undefined || !malformed) {
    return [];
  }

  return [
    {
      message: `Claude Code's MCP configuration at ${file.spec.path} is not a valid JSON object, so none of the servers it declares are loading — in Claude Code either. Fix the file to restore them.`,
      sourceId: file.spec.id,
    },
  ];
}

function permissionMetadata(
  settings: Readonly<Record<"global" | "local" | "project", AdapterSourceFile | undefined>>,
): JsonObject | undefined {
  const summaries: Record<string, JsonObject> = {};
  for (const [scope, file] of Object.entries(settings)) {
    if (file === undefined) {
      continue;
    }
    const summary = parsePermissionSettings(file);
    if (summary !== undefined) {
      summaries[scope] = summary;
    }
  }
  return Object.keys(summaries).length === 0 ? undefined : { [CLAUDE_PERMISSIONS_KEY]: summaries };
}

/**
 * Declares the global and project configuration Claude Code reads.
 *
 * Project instructions and MCP config are rooted at the invocation directory, not the repository
 * root, because that is where Claude Code itself looks. The local-scope MCP servers are not
 * declared here at all: they live inside the global `~/.claude.json`, which is already declared,
 * and {@link parseGlobalMcpServers} lifts them out of it.
 *
 * Permission settings remain intentionally narrow: ENV-004 needs their effective default mode,
 * but the model records only that mode and rule counts rather than permission entries.
 * `settings.local.json` is declared alongside the shared project settings because it is the
 * highest-precedence file Claude Code reads here: a claim about the effective mode that ignored
 * it could be false on the very machine being scanned.
 */
function claudeFiles(input: AdapterFilesInput): readonly AdapterFileSpec[] {
  const { environment } = input;
  return [
    {
      id: SOURCE_IDS.instructions,
      kind: "instructions",
      optional: true,
      path: join(environment.homeDir, ...GLOBAL_INSTRUCTIONS_SEGMENTS),
      scope: "global",
    },
    {
      id: SOURCE_IDS.instructionsProject,
      kind: "instructions",
      optional: true,
      path: join(environment.cwd, "CLAUDE.md"),
      scope: "project",
    },
    {
      id: SOURCE_IDS.mcp,
      kind: "mcp",
      optional: true,
      path: join(environment.homeDir, ".claude.json"),
      scope: "global",
    },
    {
      id: SOURCE_IDS.mcpProject,
      kind: "mcp",
      optional: true,
      path: join(environment.cwd, ".mcp.json"),
      scope: "project",
    },
    {
      id: SOURCE_IDS.settingsGlobal,
      kind: "config",
      optional: true,
      path: join(environment.homeDir, ".claude", "settings.json"),
      scope: "global",
    },
    {
      id: SOURCE_IDS.settingsLocal,
      kind: "config",
      optional: true,
      path: join(environment.cwd, ".claude", "settings.local.json"),
      scope: "project",
    },
    {
      id: SOURCE_IDS.settingsProject,
      kind: "config",
      optional: true,
      path: join(environment.cwd, ".claude", "settings.json"),
      scope: "project",
    },
    ...skillDirectorySpecs(input, SKILL_DIRECTORIES),
  ];
}
