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
});

describe("Claude Code candidate search", () => {
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
  it("declares the managed shared-instructions import", () => {
    expect(claudeCodeAdapter.sharedLink).toEqual({
      entryPath: "~/.claude/CLAUDE.md",
      kind: "import-line",
      lineTemplate: "@{{sharedInstructions}}",
    });
  });

  it("declares the instruction-loading model checks read instead of hard-coding it", () => {
    expect(claudeCodeAdapter.capabilities).toEqual({
      instructions: { importDepthLimit: 5, importStyle: "at-import", loading: "import-graph" },
      skills: {
        directories: [
          { entryPath: "~/.claude/skills", id: "claude-code.skills.global" },
          { entryPath: "./.claude/skills", id: "claude-code.skills.project" },
        ],
      },
    });
  });

  it("declares global and project instructions, MCP configuration, and permission settings", () => {
    const environment = environmentWithExec([], () => result(0));

    expect(
      claudeCodeAdapter.files({
        detection: { installed: true },
        environment,
        files: new Map(),
      }),
    ).toEqual([
      {
        id: "claude-code.instructions.global",
        kind: "instructions",
        optional: true,
        path: "/home/dev/.claude/CLAUDE.md",
        scope: "global",
      },
      {
        id: "claude-code.instructions.project",
        kind: "instructions",
        optional: true,
        path: "/workspace/CLAUDE.md",
        scope: "project",
      },
      {
        id: "claude-code.mcp.global",
        kind: "mcp",
        optional: true,
        path: "/home/dev/.claude.json",
        scope: "global",
      },
      {
        id: "claude-code.mcp.project",
        kind: "mcp",
        optional: true,
        path: "/workspace/.mcp.json",
        scope: "project",
      },
      {
        id: "claude-code.settings.global",
        kind: "config",
        optional: true,
        path: "/home/dev/.claude/settings.json",
        scope: "global",
      },
      {
        id: "claude-code.settings.local",
        kind: "config",
        optional: true,
        path: "/workspace/.claude/settings.local.json",
        scope: "project",
      },
      {
        id: "claude-code.settings.project",
        kind: "config",
        optional: true,
        path: "/workspace/.claude/settings.json",
        scope: "project",
      },
      {
        id: "claude-code.skills.global",
        kind: "skills",
        optional: true,
        path: "/home/dev/.claude/skills",
        scope: "global",
      },
      {
        id: "claude-code.skills.project",
        kind: "skills",
        optional: true,
        path: "/workspace/.claude/skills",
        scope: "project",
      },
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
