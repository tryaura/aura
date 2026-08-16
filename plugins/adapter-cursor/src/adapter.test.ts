import {
  COMMAND_NOT_FOUND_EXIT_CODE,
  TIMEOUT_EXIT_CODE,
  type AdapterFileMap,
  type AdapterSourceFile,
  type Environment,
  type ExecRequest,
  type ExecResult,
} from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { cursorAdapter } from "./adapter.js";

describe("Cursor detection", () => {
  it("detects the first Cursor executable that reports a version", async () => {
    const requests: ExecRequest[] = [];
    const environment = environmentWithExec(requests, (request) =>
      request.command === "/first/cursor"
        ? result(COMMAND_NOT_FOUND_EXIT_CODE)
        : result(0, "3.11.0\nfixture-commit\narm64\n"),
    );

    await expect(cursorAdapter.detect(environment)).resolves.toEqual({
      executablePath: "/second/cursor",
      installed: true,
      version: "3.11.0",
    });
    expect(requests.map((request) => [request.command, ...(request.args ?? [])])).toEqual([
      ["/first/cursor", "--version"],
      ["/second/cursor", "--version"],
    ]);
  });

  it.each([
    ["exits unsuccessfully", result(2, "3.11.0\n")],
    ["does not identify a version", result(0, "Cursor editor\n")],
    ["times out", result(TIMEOUT_EXIT_CODE)],
  ])("keeps searching when a candidate %s", async (_case, response) => {
    const environment = environmentWithExec([], (request) =>
      request.command === "/first/cursor" ? response : result(0, "3.11.0\n"),
    );

    await expect(cursorAdapter.detect(environment)).resolves.toMatchObject({
      executablePath: "/second/cursor",
      installed: true,
    });
  });

  it("probes the cursor.cmd shim on Windows", async () => {
    const requests: ExecRequest[] = [];
    const base = environmentWithExec(requests, () => result(0, "3.11.0\n"));
    const environment: Environment = { ...base, platform: "win32" };

    await expect(cursorAdapter.detect(environment)).resolves.toEqual({
      executablePath: "/first/cursor.cmd",
      installed: true,
      version: "3.11.0",
    });
  });

  it("probes unique absolute search entries only", async () => {
    const requests: ExecRequest[] = [];
    const base = environmentWithExec(requests, () => result(COMMAND_NOT_FOUND_EXIT_CODE));
    const environment: Environment = {
      ...base,
      pathEntries: ["relative", "/first", "/first", "/second"],
    };

    await expect(cursorAdapter.detect(environment)).resolves.toEqual({ installed: false });
    expect(requests.map((request) => request.command)).toEqual(["/first/cursor", "/second/cursor"]);
  });
});

describe("Cursor file specifications", () => {
  it("declares the whole-owned shared-instructions wrapper", () => {
    expect(cursorAdapter.sharedLink).toEqual({
      entryPath: "./.cursor/rules/aura.mdc",
      kind: "native-copy",
      lineTemplate: "---\nalwaysApply: true\n---\n\n@file {{sharedInstructions}}\n",
    });
  });

  it("declares modern, legacy, and AGENTS.md rules plus global and project MCP configuration", () => {
    const environment = environmentWithExec([], () => result(0));

    expect(cursorAdapter.files(environment, { installed: true }, new Map())).toEqual([
      {
        id: "cursor.rules.project",
        kind: "instructions",
        optional: true,
        path: "/workspace/.cursor/rules",
        scope: "project",
      },
      {
        id: "cursor.rules.project.legacy",
        kind: "instructions",
        optional: true,
        path: "/workspace/.cursorrules",
        scope: "project",
      },
      {
        id: "cursor.rules.project.agents",
        kind: "instructions",
        optional: true,
        path: "/workspace/AGENTS.md",
        scope: "project",
      },
      {
        id: "cursor.rules.project/aura-owned",
        kind: "instructions",
        optional: true,
        path: "/workspace/.cursor/rules/aura.mdc",
        scope: "project",
      },
      {
        id: "cursor.mcp.global",
        kind: "mcp",
        optional: true,
        path: "/home/dev/.cursor/mcp.json",
        scope: "global",
      },
      {
        id: "cursor.mcp.project",
        kind: "mcp",
        optional: true,
        path: "/workspace/.cursor/mcp.json",
        scope: "project",
      },
    ]);
  });

  it("discovers every nested rule entry with stable path-based ids", () => {
    const environment = environmentWithExec([], () => result(0));
    const files: AdapterFileMap = new Map([
      [
        "cursor.rules.project",
        source("cursor.rules.project", "/workspace/.cursor/rules", "project", [
          "api.mdc",
          "frontend",
        ]),
      ],
      [
        "cursor.rules.project/frontend",
        source("cursor.rules.project/frontend", "/workspace/.cursor/rules/frontend", "project", [
          "react patterns.mdc",
        ]),
      ],
    ]);

    expect(cursorAdapter.files(environment, { installed: true }, files).slice(6)).toEqual([
      {
        id: "cursor.rules.project/api.mdc",
        kind: "instructions",
        optional: true,
        path: "/workspace/.cursor/rules/api.mdc",
        scope: "project",
      },
      {
        id: "cursor.rules.project/frontend",
        kind: "instructions",
        optional: true,
        path: "/workspace/.cursor/rules/frontend",
        scope: "project",
      },
      {
        id: "cursor.rules.project/frontend/react%20patterns.mdc",
        kind: "instructions",
        optional: true,
        path: "/workspace/.cursor/rules/frontend/react patterns.mdc",
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

function source(
  id: string,
  path: string,
  scope: "global" | "project",
  entries: readonly string[],
): AdapterSourceFile {
  return {
    entries,
    exists: true,
    spec: { id, kind: "instructions", path, scope },
  };
}
