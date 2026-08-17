import { join } from "node:path";

import {
  defineAdapter,
  detectExecutable,
  parseInstalledSkills,
  skillDirectorySpecs,
  type AdapterFileSpec,
  type AdapterFilesInput,
  type AdapterProblem,
  type AdapterSkillDirectory,
  type AdapterSourceFile,
  type Scope,
} from "@tryaura/aura-sdk";

import {
  CODEX_ADAPTER_ID,
  CODEX_OVERRIDE_SUFFIX,
  CODEX_PROJECT_TRUST_KEY,
  CODEX_SOURCE_IDS as SOURCE_IDS,
} from "./contract.js";
import { parseCodexProjectSettings } from "./config.js";
import { selectInstructionFiles } from "./instructions.js";
import { parseMcpServers } from "./mcp.js";
import { codexProjectInstructionFiles } from "./project-instructions.js";
import { parseProjectTrust } from "./trust.js";

const SKILL_DIRECTORIES: readonly AdapterSkillDirectory[] = Object.freeze([
  { entryPath: "~/.codex/skills", id: SOURCE_IDS.skillsGlobal },
]);

export const codexAdapter = defineAdapter({
  capabilities: {
    // Codex loads its AGENTS.md chain whole and reads `@` references as prose.
    instructions: { importStyle: "none", loading: "all-files" },
    skills: { directories: SKILL_DIRECTORIES },
  },
  detect: (environment) =>
    detectExecutable(environment, { authenticationArgs: ["login", "status"], binaryName: "codex" }),
  detectionScope: "the codex CLI on PATH (the desktop app is not checked)",
  displayName: "Codex",
  files: codexFiles,
  id: CODEX_ADAPTER_ID,
  installHint:
    "Run `npm install -g @openai/codex@latest`, or update Codex with your package manager.",
  parse: (input) => {
    const { cwd, files, homeDir, projectRoot } = input;
    const mcp = files.get(SOURCE_IDS.mcp);
    const mcpConfig = mcp === undefined ? EMPTY_MCP : parseMcpServers(mcp);
    const settings = parseCodexProjectSettings(mcp);
    const instructions = selectInstructionFiles(files, {
      homeDir,
      projectMaxBytes: settings.maxBytes,
    });

    return {
      instructionFiles: instructions.documents,
      mcpServers: mcpConfig.servers,
      metadata: {
        [CODEX_PROJECT_TRUST_KEY]:
          mcp === undefined ? "unknown" : parseProjectTrust(mcp, { cwd, projectRoot }),
      },
      problems: [
        ...shadowedEntryProblems(instructions.shadowed),
        ...unusableConfig(mcp, mcpConfig.malformed),
      ],
      skills: parseInstalledSkills(CODEX_ADAPTER_ID, input, SKILL_DIRECTORIES),
    };
  },
  sharedLink: {
    entryPath: "~/.codex/AGENTS.md",
    kind: "symlink",
  },
  // Codex's configuration format churns from minor to minor, so support is pinned to the window
  // this adapter's parsing was verified against and widened only after re-verification. Cursor's
  // adapter takes the opposite bet: its format has been stable, so it declares a wide range.
  supportedRange: ">=0.146.0 <0.148.0",
});

/** What an absent file contributes, so `parse` reads the same whether or not one was found. */
const EMPTY_MCP = Object.freeze({ malformed: false, servers: [] });

/**
 * Reports configuration that is present but unreadable.
 *
 * The failure this describes is invisible from the outside: Codex refuses the whole file, so every
 * setting in it stops applying at once while the file still sits there looking configured. The
 * message names that whole blast radius rather than only the MCP servers this module happens to
 * parse — `config.toml` also carries project trust, and a reader told only about MCP would go
 * looking for a second, unrelated fault. Silence is the wrong answer from a tool whose job is
 * explaining that.
 */
function unusableConfig(
  file: AdapterSourceFile | undefined,
  malformed: boolean,
): readonly AdapterProblem[] {
  if (file === undefined || !malformed) {
    return [];
  }

  return [
    {
      message: `Codex's configuration at ${file.spec.path} is not valid TOML, so Codex ignores the entire file: none of the MCP servers, project trust entries, or other settings it declares are in effect. Fix the file to restore them.`,
      sourceId: file.spec.id,
    },
  ];
}

/** Reports an override that shadows the file Aura's own shared link writes to. */
function shadowedEntryProblems(shadowed: readonly AdapterSourceFile[]): readonly AdapterProblem[] {
  return shadowed
    .filter((file) => file.spec.id === SOURCE_IDS.instructions)
    .map((file) => ({
      message: `Codex reads AGENTS.override.md instead of ${file.spec.path}, so whatever that file loads — including Aura's shared instruction link — is not reaching Codex. Move the guidance into the override file, or remove it.`,
      sourceId: file.spec.id,
    }));
}

/**
 * Declares global configuration first, then probes project candidates without loading them.
 *
 * The first round reads `config.toml` and the two global candidates. Later rounds inspect configured
 * root markers and project candidate filenames, then read only the candidate Codex selects at each
 * level. Selected files carry the aggregate project-document byte limit into core's read.
 */
function codexFiles(input: AdapterFilesInput): readonly AdapterFileSpec[] {
  const { environment, files, projectRoot } = input;
  const codexHome = join(environment.homeDir, ".codex");
  const declarations: AdapterFileSpec[] = [
    ...instructionLevel(codexHome, SOURCE_IDS.instructions, "global"),
    {
      id: SOURCE_IDS.mcp,
      kind: "mcp",
      optional: true,
      path: join(codexHome, "config.toml"),
      scope: "global",
    },
    ...skillDirectorySpecs(input, SKILL_DIRECTORIES),
  ];

  const config = files.get(SOURCE_IDS.mcp);
  if (config === undefined) {
    return declarations;
  }

  declarations.push(
    ...codexProjectInstructionFiles(
      environment,
      files,
      projectRoot,
      parseCodexProjectSettings(config),
    ),
  );
  return declarations;
}

/** The two global instruction candidates, in Codex's preference order. */
function instructionLevel(directory: string, id: string, scope: Scope): readonly AdapterFileSpec[] {
  return [
    {
      id: `${id}${CODEX_OVERRIDE_SUFFIX}`,
      kind: "instructions",
      optional: true,
      path: join(directory, "AGENTS.override.md"),
      scope,
    },
    {
      id,
      kind: "instructions",
      optional: true,
      path: join(directory, "AGENTS.md"),
      scope,
    },
  ];
}
