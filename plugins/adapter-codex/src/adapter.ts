import { join } from "node:path";

import {
  defineAdapter,
  detectExecutable,
  type AdapterDetection,
  type AdapterFileMap,
  type AdapterFileSpec,
  type AdapterProblem,
  type AdapterSourceFile,
  type Environment,
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

export const codexAdapter = defineAdapter({
  detect: (environment) =>
    detectExecutable(environment, { authenticationArgs: ["login", "status"], binaryName: "codex" }),
  displayName: "Codex",
  files: codexFiles,
  id: CODEX_ADAPTER_ID,
  installHint:
    "Run `npm install -g @openai/codex@latest`, or update Codex with your package manager.",
  parse: ({ cwd, files, homeDir, projectRoot }) => {
    const mcp = files.get(SOURCE_IDS.mcp);
    const settings = parseCodexProjectSettings(mcp);
    const instructions = selectInstructionFiles(files, {
      homeDir,
      projectMaxBytes: settings.maxBytes,
    });

    return {
      instructionFiles: instructions.documents,
      mcpServers: mcp?.content === undefined ? [] : parseMcpServers(mcp),
      metadata: {
        [CODEX_PROJECT_TRUST_KEY]:
          mcp === undefined ? "unknown" : parseProjectTrust(mcp, { cwd, projectRoot }),
      },
      problems: shadowedEntryProblems(instructions.shadowed),
      skills: [],
    };
  },
  sharedLink: {
    entryPath: "~/.codex/AGENTS.md",
    kind: "symlink",
  },
  supportedRange: ">=0.146.0 <0.148.0",
});

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
function codexFiles(
  environment: Environment,
  _detection: AdapterDetection,
  files: AdapterFileMap,
  projectRoot: string | undefined,
): readonly AdapterFileSpec[] {
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
