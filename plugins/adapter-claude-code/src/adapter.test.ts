import {
  COMMAND_NOT_FOUND_EXIT_CODE,
  TIMEOUT_EXIT_CODE,
  type Environment,
  type ExecRequest,
  type ExecResult,
} from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { claudeCodeAdapter } from "./adapter.js";

describe("Claude Code detection", () => {
  it("detects the first installed executable and checks authentication without logging in", async () => {
    const requests: ExecRequest[] = [];
    const environment = environmentWithExec(requests, (request) => {
      if (request.command === "/first/claude") {
        return result(COMMAND_NOT_FOUND_EXIT_CODE);
      }
      if (request.args?.[0] === "--version") {
        return result(0, "2.1.233 (Claude Code)\n");
      }
      return result(0, '{"loggedIn":true}\n');
    });

    await expect(claudeCodeAdapter.detect(environment)).resolves.toEqual({
      authenticated: true,
      executablePath: "/second/claude",
      installed: true,
      version: "2.1.233",
    });
    expect(requests.map((request) => [request.command, ...(request.args ?? [])])).toEqual([
      ["/first/claude", "--version"],
      ["/second/claude", "--version"],
      ["/second/claude", "auth", "status"],
    ]);
  });

  it.each([
    [1, false],
    [2, undefined],
  ])("maps auth status exit %i to %s", async (exitCode, authenticated) => {
    const environment = environmentWithExec([], (request) =>
      request.args?.[0] === "--version" ? result(0, "2.1.233 (Claude Code)\n") : result(exitCode),
    );

    const detection = await claudeCodeAdapter.detect(environment);
    expect(detection.authenticated).toBe(authenticated);
  });

  it("reports the application absent without probing authentication", async () => {
    const requests: ExecRequest[] = [];
    const environment = environmentWithExec(requests, () => result(COMMAND_NOT_FOUND_EXIT_CODE));

    await expect(claudeCodeAdapter.detect(environment)).resolves.toEqual({ installed: false });
    expect(requests.map((request) => request.args)).toEqual([["--version"], ["--version"]]);
  });

  it.each([
    ["exits without reporting a version", result(2, "usage: claude [options]\n")],
    ["reports something that is not a version", result(0, "claude, the card game\n")],
    ["hangs until the timeout kills it", result(TIMEOUT_EXIT_CODE)],
  ])("keeps searching when an executable %s", async (_case, response) => {
    const requests: ExecRequest[] = [];
    const environment = environmentWithExec(requests, (request) =>
      request.command === "/first/claude" ? response : result(0, "2.1.233 (Claude Code)\n"),
    );

    await expect(claudeCodeAdapter.detect(environment)).resolves.toMatchObject({
      executablePath: "/second/claude",
      installed: true,
      version: "2.1.233",
    });
    // The impostor is never asked about authentication.
    expect(requests.filter((request) => request.command === "/first/claude")).toHaveLength(1);
  });

  it("probes each search path entry once", async () => {
    const requests: ExecRequest[] = [];
    const base = environmentWithExec(requests, () => result(COMMAND_NOT_FOUND_EXIT_CODE));
    const environment: Environment = { ...base, pathEntries: ["/dup", "/dup", "/other"] };

    await expect(claudeCodeAdapter.detect(environment)).resolves.toEqual({ installed: false });
    expect(requests.map((request) => request.command)).toEqual(["/dup/claude", "/other/claude"]);
  });

  it("ignores relative executable search entries", async () => {
    const requests: ExecRequest[] = [];
    const base = environmentWithExec(requests, () => result(COMMAND_NOT_FOUND_EXIT_CODE));
    const environment: Environment = { ...base, pathEntries: ["relative", "/absolute"] };

    await expect(claudeCodeAdapter.detect(environment)).resolves.toEqual({ installed: false });
    expect(requests.map((request) => request.command)).toEqual(["/absolute/claude"]);
  });
});

describe("Claude Code file specifications", () => {
  it("declares only the optional global instruction and MCP files", () => {
    const environment = environmentWithExec([], () => result(0));

    expect(claudeCodeAdapter.files(environment)).toEqual([
      {
        id: "claude-code.instructions.global",
        kind: "instructions",
        optional: true,
        path: "/home/dev/.claude/CLAUDE.md",
        scope: "global",
      },
      {
        id: "claude-code.mcp.global",
        kind: "mcp",
        optional: true,
        path: "/home/dev/.claude.json",
        scope: "global",
      },
    ]);
  });
});

describe("Claude Code parsing", () => {
  it("resolves home-relative imports against the home directory the spec was built from", () => {
    const snapshot = claudeCodeAdapter.parse({
      detection: { installed: true },
      files: [
        {
          content: "@~/agents/AGENTS.md\n",
          exists: true,
          spec: {
            id: "claude-code.instructions.global",
            kind: "instructions",
            path: "/home/dev/.claude/CLAUDE.md",
            scope: "global",
          },
        },
      ],
    });

    expect(snapshot.instructionFiles[0]?.links).toEqual([
      { kind: "import", targetPath: "/home/dev/agents/AGENTS.md", valid: false },
    ]);
  });
});

function environmentWithExec(
  requests: ExecRequest[],
  respond: (request: ExecRequest) => ExecResult,
): Environment {
  return {
    cwd: "/workspace",
    exec: (request) => {
      requests.push(request);
      return Promise.resolve(respond(request));
    },
    homeDir: "/home/dev",
    now: () => new Date(0),
    pathEntries: ["/first", "/second"],
    platform: "linux",
  };
}

function result(exitCode: number, stdout = ""): ExecResult {
  return { exitCode, stderr: "", stdout };
}
