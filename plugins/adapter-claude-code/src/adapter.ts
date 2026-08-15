import { dirname, join } from "node:path";

import {
  defineAdapter,
  findVersionedExecutable,
  type AdapterDetection,
  type AdapterFileSpec,
  type Environment,
} from "@tryaura/aura-sdk";

import { parseInstructionFile } from "./instructions.js";
import { parseMcpServers } from "./mcp.js";

/** Path segments {@link globalFiles} appends to the home directory for the instruction file. */
const GLOBAL_INSTRUCTIONS_SEGMENTS = Object.freeze([".claude", "CLAUDE.md"]);

const SOURCE_IDS = Object.freeze({
  instructions: "claude-code.instructions.global",
  mcp: "claude-code.mcp.global",
});

export const claudeCodeAdapter = defineAdapter({
  detect: detectClaudeCode,
  displayName: "Claude Code",
  files: globalFiles,
  id: "claude-code",
  parse: ({ files }) => {
    const instructions = files.get(SOURCE_IDS.instructions);
    const mcp = files.get(SOURCE_IDS.mcp);

    return {
      instructionFiles:
        instructions?.content === undefined
          ? []
          : [parseInstructionFile(instructions, homeDirOf(instructions.spec.path))],
      mcpServers: mcp?.content === undefined ? [] : parseMcpServers(mcp),
      skills: [],
    };
  },
  supportedRange: ">=2.1.0 <3.0.0",
});

/**
 * Finds a Claude Code installation on the search path and asks it about its credentials.
 *
 * The walk itself — accept a candidate only once `--version` reports a parseable version, skip
 * duplicate and relative entries — is {@link findVersionedExecutable}, so `auth status` never
 * runs against an unrelated `claude` that happened to sit on the path.
 */
async function detectClaudeCode(environment: Environment): Promise<AdapterDetection> {
  const found = await findVersionedExecutable(
    environment,
    environment.platform === "win32" ? "claude.exe" : "claude",
  );
  if (found === undefined) {
    return { installed: false };
  }

  const authentication = await environment.exec({
    args: ["auth", "status"],
    command: found.executablePath,
    timeoutMs: 5_000,
  });
  const authenticated = authenticationStatus(authentication.exitCode);

  return {
    ...found,
    installed: true,
    ...(authenticated === undefined ? {} : { authenticated }),
  };
}

/**
 * Declares the global configuration Claude Code keeps under the home directory.
 *
 * Global scope only. Project state — `./CLAUDE.md`, `.claude/CLAUDE.md`, `.mcp.json`, and the
 * per-directory servers under `projects` in `~/.claude.json` — is not read yet, so a workspace's
 * own configuration does not appear in the model.
 *
 * `~/.claude/settings.json` is deliberately absent: nothing parses it, and declaring a path costs
 * a read on every scan.
 */
function globalFiles(environment: Environment): readonly AdapterFileSpec[] {
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
  ];
}

/**
 * Recovers the home directory from the path {@link globalFiles} built out of it.
 *
 * `parse` is pure and never receives an `Environment`, so this is where the home directory still
 * exists. Undoing the join beside the join itself keeps the two from drifting, and leaves the
 * instruction parser free of any assumption about where its document sits.
 */
function homeDirOf(instructionsPath: string): string {
  return GLOBAL_INSTRUCTIONS_SEGMENTS.reduce((path) => dirname(path), instructionsPath);
}

function authenticationStatus(exitCode: number): boolean | undefined {
  if (exitCode === 0) {
    return true;
  }
  if (exitCode === 1) {
    return false;
  }
  return undefined;
}
