import {
  COMMAND_NOT_FOUND_EXIT_CODE,
  TIMEOUT_EXIT_CODE,
  type AdapterSourceFile,
  type Environment,
  type EnvironmentPlatform,
  type ExecRequest,
  type ExecResult,
} from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { codexAdapter } from "./adapter.js";

describe("Codex detection", () => {
  it("detects the first Codex executable and checks authentication without logging in", async () => {
    const requests: ExecRequest[] = [];
    const environment = environmentWithExec(requests, (request) => {
      if (request.command === "/first/codex") {
        return result(COMMAND_NOT_FOUND_EXIT_CODE);
      }
      return request.args?.[0] === "--version"
        ? result(0, "codex-cli 0.147.0\n")
        : result(0, "Logged in using ChatGPT\n");
    });

    await expect(codexAdapter.detect(environment)).resolves.toEqual({
      authenticated: true,
      executablePath: "/second/codex",
      installed: true,
      version: "0.147.0",
    });
    expect(requests.map((request) => [request.command, ...(request.args ?? [])])).toEqual([
      ["/first/codex", "--version"],
      ["/second/codex", "--version"],
      ["/second/codex", "login", "status"],
    ]);
  });

  it.each([
    [1, false],
    [2, undefined],
  ])("maps login status exit %i to %s", async (exitCode, authenticated) => {
    const environment = environmentWithExec([], (request) =>
      request.args?.[0] === "--version" ? result(0, "codex-cli 0.146.0\n") : result(exitCode),
    );

    const detection = await codexAdapter.detect(environment);
    expect(detection.authenticated).toBe(authenticated);
  });

  it("reports Codex absent without probing authentication", async () => {
    const requests: ExecRequest[] = [];
    const environment = environmentWithExec(requests, () => result(COMMAND_NOT_FOUND_EXIT_CODE));

    await expect(codexAdapter.detect(environment)).resolves.toEqual({ installed: false });
    expect(requests.map((request) => request.args)).toEqual([["--version"], ["--version"]]);
  });

  it.each([
    ["exits without a version", result(2, "usage: codex\n")],
    ["reports non-version output", result(0, "codex, the manuscript\n")],
    ["times out", result(TIMEOUT_EXIT_CODE)],
  ])("keeps searching when a candidate %s", async (_case, response) => {
    const requests: ExecRequest[] = [];
    const environment = environmentWithExec(requests, (request) =>
      request.command === "/first/codex" ? response : result(0, "codex-cli 0.147.0\n"),
    );

    await expect(codexAdapter.detect(environment)).resolves.toMatchObject({
      executablePath: "/second/codex",
      installed: true,
      version: "0.147.0",
    });
    expect(requests.filter((request) => request.command === "/first/codex")).toHaveLength(1);
  });

  it("skips duplicate and relative PATH entries", async () => {
    const requests: ExecRequest[] = [];
    const base = environmentWithExec(requests, () => result(COMMAND_NOT_FOUND_EXIT_CODE));
    const environment: Environment = {
      ...base,
      pathEntries: ["relative", "/absolute", "/absolute"],
    };

    await expect(codexAdapter.detect(environment)).resolves.toEqual({ installed: false });
    expect(requests.map((request) => request.command)).toEqual(["/absolute/codex"]);
  });

  it("uses the Windows executable name", async () => {
    const requests: ExecRequest[] = [];
    const environment = environmentWithExec(
      requests,
      () => result(COMMAND_NOT_FOUND_EXIT_CODE),
      "win32",
    );

    await codexAdapter.detect(environment);
    expect(requests[0]?.command).toBe("/first/codex.exe");
  });
});

describe("Codex global model", () => {
  it("declares the shared-instructions symlink", () => {
    expect(codexAdapter.sharedLink).toEqual({
      entryPath: "~/.codex/AGENTS.md",
      kind: "symlink",
    });
  });

  it("declares global instructions and configuration before project discovery", () => {
    const environment = environmentWithExec([], () => result(0));

    expect(codexAdapter.files(environment, { installed: true }, new Map(), undefined)).toEqual([
      {
        id: "codex.instructions.global.override",
        kind: "instructions",
        optional: true,
        path: "/home/dev/.codex/AGENTS.override.md",
        scope: "global",
      },
      {
        id: "codex.instructions.global",
        kind: "instructions",
        optional: true,
        path: "/home/dev/.codex/AGENTS.md",
        scope: "global",
      },
      {
        id: "codex.mcp.global",
        kind: "mcp",
        optional: true,
        path: "/home/dev/.codex/config.toml",
        scope: "global",
      },
    ]);
  });

  it("models a real AGENTS.md as user-owned content", () => {
    const instructions = sourceFile("codex.instructions.global", "instructions", "# Global\n");
    const snapshot = codexAdapter.parse({
      cwd: "/workspace",
      detection: { installed: true },
      files: new Map([[instructions.spec.id, instructions]]),
      homeDir: "/home/dev",
    });

    expect(snapshot.instructionFiles).toEqual([
      {
        content: "# Global\n",
        links: [],
        path: "/home/dev/.codex/AGENTS.md",
        scope: "global",
        sourceId: "codex.instructions.global",
      },
    ]);
  });

  it.each([
    ['[projects."/repo"]\ntrust_level = "trusted"\n', "trusted"],
    ['[projects."/repo"]\ntrust_level = "untrusted"\n', "untrusted"],
    ['[projects."/somewhere-else"]\ntrust_level = "trusted"\n', "unknown"],
    // Codex keys by the directory it was launched in, which is routinely inside the repository.
    ['[projects."/repo/packages/app"]\ntrust_level = "trusted"\n', "trusted"],
    ['[projects."/repo/packages"]\ntrust_level = "untrusted"\n', "untrusted"],
    // A trailing separator is the same directory.
    ['[projects."/repo/"]\ntrust_level = "trusted"\n', "trusted"],
    // Above the repository root is a different project, so it is not consulted.
    ['[projects."/"]\ntrust_level = "trusted"\n', "unknown"],
  ])("records the current project trust level", (content, expected) => {
    const config = sourceFile("codex.mcp.global", "mcp", content);
    const snapshot = codexAdapter.parse({
      cwd: "/repo/packages/app",
      detection: { installed: true },
      files: new Map([[config.spec.id, config]]),
      homeDir: "/home/dev",
      projectRoot: "/repo",
    });

    expect(snapshot.metadata).toEqual({ projectTrust: expected });
  });

  it("prefers the narrowest recorded directory when several are trusted differently", () => {
    const config = sourceFile(
      "codex.mcp.global",
      "mcp",
      '[projects."/repo"]\ntrust_level = "trusted"\n' +
        '[projects."/repo/packages/app"]\ntrust_level = "untrusted"\n',
    );

    expect(
      codexAdapter.parse({
        cwd: "/repo/packages/app",
        detection: { installed: true },
        files: new Map([[config.spec.id, config]]),
        homeDir: "/home/dev",
        projectRoot: "/repo",
      }).metadata,
    ).toEqual({ projectTrust: "untrusted" });
  });

  it("uses cwd for trust lookup only when no repository root was found", () => {
    const config = sourceFile(
      "codex.mcp.global",
      "mcp",
      '[projects."/workspace"]\ntrust_level = "trusted"\n',
    );

    expect(
      codexAdapter.parse({
        cwd: "/workspace",
        detection: { installed: true },
        files: new Map([[config.spec.id, config]]),
        homeDir: "/home/dev",
      }).metadata,
    ).toEqual({ projectTrust: "trusted" });
  });

  it("claims nothing about a path core refused to read", () => {
    const instructions: AdapterSourceFile = {
      exists: true,
      problem: "denied",
      spec: {
        id: "codex.instructions.global",
        kind: "instructions",
        path: "/home/dev/.codex/AGENTS.md",
        scope: "global",
      },
    };
    const snapshot = codexAdapter.parse({
      cwd: "/workspace",
      detection: { installed: true },
      files: new Map([[instructions.spec.id, instructions]]),
      homeDir: "/home/dev",
    });

    // An empty document here would assert the user wrote nothing where nobody looked.
    expect(snapshot.instructionFiles).toEqual([]);
  });
});

function environmentWithExec(
  requests: ExecRequest[],
  respond: (request: ExecRequest) => ExecResult,
  platform: EnvironmentPlatform = "linux",
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
    platform,
  };
}

function sourceFile(id: string, kind: "instructions" | "mcp", content: string): AdapterSourceFile {
  return {
    content,
    exists: true,
    spec: {
      id,
      kind,
      path: kind === "mcp" ? "/home/dev/.codex/config.toml" : "/home/dev/.codex/AGENTS.md",
      scope: "global",
    },
  };
}

function result(exitCode: number, stdout = ""): ExecResult {
  return { exitCode, stderr: "", stdout };
}
