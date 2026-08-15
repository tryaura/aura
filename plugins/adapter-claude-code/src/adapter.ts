import { dirname, isAbsolute, join } from "node:path";

import {
  defineAdapter,
  type AdapterDetection,
  type AdapterFileSpec,
  type Environment,
  type ExecResult,
} from "@tryaura/aura-sdk";

import { parseInstructionFile } from "./instructions.js";
import { parseMcpServers } from "./mcp.js";

const VERSION_PATTERN = /(?:^|\s|v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u;

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
    const instructions = files.find((file) => file.spec.id === SOURCE_IDS.instructions);
    const mcp = files.find((file) => file.spec.id === SOURCE_IDS.mcp);

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
 * Walks the search path for an executable that identifies itself as Claude Code.
 *
 * A candidate is accepted only once `--version` reports a version Aura can parse. Treating any
 * exit code other than "missing" as success meant an unrelated `claude` on the path — or one that
 * hung until the timeout killed it — ended the walk and was reported as an installation, with
 * `auth status` already run against it.
 *
 * Duplicate path entries are skipped. Nothing here touches the filesystem: an adapter has no
 * reader, so probing an entry means running it, and running it once each is the floor.
 */
async function detectClaudeCode(environment: Environment): Promise<AdapterDetection> {
  const probed = new Set<string>();

  for (const pathEntry of environment.pathEntries) {
    if (!isAbsolute(pathEntry) || probed.has(pathEntry)) {
      continue;
    }
    probed.add(pathEntry);

    const executablePath = join(
      pathEntry,
      environment.platform === "win32" ? "claude.exe" : "claude",
    );
    const version = parseVersion(
      await environment.exec({
        args: ["--version"],
        command: executablePath,
        timeoutMs: 5_000,
      }),
    );

    if (version === undefined) {
      continue;
    }

    const authentication = await environment.exec({
      args: ["auth", "status"],
      command: executablePath,
      timeoutMs: 5_000,
    });
    const authenticated = authenticationStatus(authentication.exitCode);

    return {
      executablePath,
      installed: true,
      version,
      ...(authenticated === undefined ? {} : { authenticated }),
    };
  }

  return { installed: false };
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

function parseVersion(result: ExecResult): string | undefined {
  if (result.exitCode !== 0) {
    return undefined;
  }
  return VERSION_PATTERN.exec(result.stdout)?.[1];
}
