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

  it("declares global and project instructions, MCP configuration, and permission settings", () => {
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
        id: "claude-code.settings.project",
        kind: "config",
        optional: true,
        path: "/workspace/.claude/settings.json",
        scope: "project",
      },
    ]);
  });
});

describe("Claude Code parsing", () => {
  it("records global and project permission summaries without permission entries", () => {
    const snapshot = claudeCodeAdapter.parse({
      cwd: "/workspace",
      detection: { installed: true },
      files: new Map([
        [
          "claude-code.settings.global",
          {
            content: JSON.stringify({
              permissions: {
                allow: ["Bash(secret-command)", "Read"],
                defaultMode: "dontAsk",
                deny: ["WebFetch"],
              },
            }),
            exists: true,
            spec: {
              id: "claude-code.settings.global",
              kind: "config",
              path: "/home/dev/.claude/settings.json",
              scope: "global",
            },
          },
        ],
        [
          "claude-code.settings.project",
          {
            content: JSON.stringify({
              permissions: { allow: ["Edit"], defaultMode: "plan", deny: [] },
            }),
            exists: true,
            spec: {
              id: "claude-code.settings.project",
              kind: "config",
              path: "/workspace/.claude/settings.json",
              scope: "project",
            },
          },
        ],
      ]),
      homeDir: "/home/dev",
    });

    expect(snapshot.metadata).toEqual({
      claudePermissions: {
        global: { allowCount: 2, defaultMode: "dontAsk", denyCount: 1 },
        project: { allowCount: 1, defaultMode: "plan", denyCount: 0 },
      },
    });
    expect(JSON.stringify(snapshot.metadata)).not.toContain("secret-command");
  });

  it("drops malformed settings metadata while preserving MCP results", () => {
    const snapshot = claudeCodeAdapter.parse({
      cwd: "/workspace",
      detection: { installed: true },
      files: new Map([
        [
          "claude-code.mcp.global",
          {
            content: JSON.stringify({ mcpServers: { docs: { command: "docs-server" } } }),
            exists: true,
            spec: {
              id: "claude-code.mcp.global",
              kind: "mcp",
              path: "/home/dev/.claude.json",
              scope: "global",
            },
          },
        ],
        [
          "claude-code.settings.global",
          {
            content: '{"permissions":{"defaultMode":"plan","allow":["secret"]}',
            exists: true,
            spec: {
              id: "claude-code.settings.global",
              kind: "config",
              path: "/home/dev/.claude/settings.json",
              scope: "global",
            },
          },
        ],
      ]),
      homeDir: "/home/dev",
    });

    expect(snapshot.metadata).toBeUndefined();
    expect(snapshot.mcpServers.map((server) => server.name)).toEqual(["docs"]);
  });

  it("resolves home-relative imports against the home directory the spec was built from", () => {
    const snapshot = claudeCodeAdapter.parse({
      cwd: "/workspace",
      detection: { installed: true },
      files: new Map([
        [
          "claude-code.instructions.global",
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
      ]),
      homeDir: "/home/dev",
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
