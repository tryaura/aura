import { join } from "node:path";

import {
  defineAdapter,
  detectExecutable,
  type AdapterFileSpec,
  type Environment,
} from "@tryaura/aura-sdk";

import { parseInstructionFile } from "./instructions.js";
import { parseMcpServers } from "./mcp.js";

const SOURCE_IDS = Object.freeze({
  instructions: "codex.instructions.global",
  mcp: "codex.mcp.global",
});

export const codexAdapter = defineAdapter({
  detect: (environment) =>
    detectExecutable(environment, { authenticationArgs: ["login", "status"], binaryName: "codex" }),
  displayName: "Codex",
  files: globalFiles,
  id: "codex",
  parse: ({ files, homeDir }) => {
    const instructions = files.get(SOURCE_IDS.instructions);
    const mcp = files.get(SOURCE_IDS.mcp);

    return {
      instructionFiles:
        instructions?.content === undefined ? [] : [parseInstructionFile(instructions, homeDir)],
      mcpServers: mcp?.content === undefined ? [] : parseMcpServers(mcp),
      skills: [],
    };
  },
  // Verified releases only: Codex ships breaking changes in 0.x minors, so the range widens one
  // verified version at a time rather than trusting a whole major like Claude Code's does.
  supportedRange: ">=0.146.0 <0.148.0",
});

function globalFiles(environment: Environment): readonly AdapterFileSpec[] {
  return [
    {
      id: SOURCE_IDS.instructions,
      kind: "instructions",
      optional: true,
      path: join(environment.homeDir, ".codex", "AGENTS.md"),
      scope: "global",
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
