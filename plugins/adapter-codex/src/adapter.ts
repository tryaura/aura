import { join } from "node:path";

import {
  defineAdapter,
  detectExecutable,
  type AdapterFileSpec,
  type Environment,
} from "@tryaura/aura-sdk";

import {
  CODEX_ADAPTER_ID,
  CODEX_PROJECT_TRUST_KEY,
  CODEX_SOURCE_IDS as SOURCE_IDS,
} from "./contract.js";
import { parseInstructionFile } from "./instructions.js";
import { parseMcpServers } from "./mcp.js";
import { parseProjectTrust } from "./trust.js";

export const codexAdapter = defineAdapter({
  detect: (environment) =>
    detectExecutable(environment, { authenticationArgs: ["login", "status"], binaryName: "codex" }),
  displayName: "Codex",
  files: codexFiles,
  id: CODEX_ADAPTER_ID,
  installHint:
    "Run `npm install -g @openai/codex@latest`, or update Codex with your package manager.",
  parse: ({ cwd, files, projectRoot }) => {
    const instructions = files.get(SOURCE_IDS.instructions);
    const mcp = files.get(SOURCE_IDS.mcp);

    return {
      // A path core refused to read — denied, oversized, outside the project — is not an empty
      // instruction file, and modelling it as one asserts the user wrote nothing where nobody
      // looked. A dangling symlink carries no `problem` and is still worth a document: the broken
      // link itself is the thing INS-002 needs to see.
      instructionFiles: [instructions, files.get(SOURCE_IDS.instructionsProject)].flatMap((file) =>
        file?.exists !== true || file.problem !== undefined ? [] : [parseInstructionFile(file)],
      ),
      mcpServers: mcp?.content === undefined ? [] : parseMcpServers(mcp),
      metadata: {
        [CODEX_PROJECT_TRUST_KEY]:
          mcp === undefined ? "unknown" : parseProjectTrust(mcp, { cwd, projectRoot }),
      },
      skills: [],
    };
  },
  sharedLink: {
    entryPath: "~/.codex/AGENTS.md",
    kind: "symlink",
  },
  // Verified releases only: Codex ships breaking changes in 0.x minors, so the range widens one
  // verified version at a time rather than trusting a whole major like Claude Code's does.
  supportedRange: ">=0.146.0 <0.148.0",
});

/**
 * Declares the global and project configuration Codex reads.
 *
 * Project instructions are rooted at the invocation directory, not the repository root, because
 * that is where Codex starts its own lookup. Codex also merges `AGENTS.md` files from nested
 * subdirectories, but discovering those would mean walking the whole tree, so they are a
 * documented non-goal — the same restraint as the Cursor adapter's nested-rules decision.
 */
function codexFiles(environment: Environment): readonly AdapterFileSpec[] {
  return [
    {
      id: SOURCE_IDS.instructions,
      kind: "instructions",
      optional: true,
      path: join(environment.homeDir, ".codex", "AGENTS.md"),
      scope: "global",
    },
    {
      id: SOURCE_IDS.instructionsProject,
      kind: "instructions",
      optional: true,
      path: join(environment.cwd, "AGENTS.md"),
      scope: "project",
    },
    {
      id: SOURCE_IDS.mcp,
      kind: "mcp",
      optional: true,
      path: join(environment.homeDir, ".codex", "config.toml"),
      scope: "global",
    },
  ];
}
