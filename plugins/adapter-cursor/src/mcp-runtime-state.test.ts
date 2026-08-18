import {
  COMMAND_NOT_FOUND_EXIT_CODE,
  TIMEOUT_EXIT_CODE,
  type AppModel,
  type Environment,
  type ExecRequest,
  type ExecResult,
  type JsonObject,
} from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { cursorAdapter } from "./adapter.js";
import { readCursorMcpRuntimeStates, readCursorMcpStateUnavailable } from "./contract.js";
import { parseCursorMcpRuntimeStates } from "./mcp-runtime-state.js";

const ESC = "\u001B";

describe("Cursor MCP runtime state detection", () => {
  it("captures ANSI-colored states from a verified cursor-agent", async () => {
    const environment = environmentWithExec([], (request) => {
      if (request.command === "/first/cursor" || request.args?.[0] === "--version") {
        return result(0, "3.11.0\n");
      }
      return result(
        0,
        [
          `${ESC}[2K${ESC}[GLoading MCPs…`,
          `${ESC}[2K${ESC}[1A${ESC}[2K${ESC}[Gappsai: ready`,
          "context7: not loaded (needs approval)",
          "fetch: disabled",
          "filesystem: Error: Connection failed",
          "git: disconnected",
          "docs: something unexpected",
          "My Server: ready",
          "noise line",
        ].join("\r\n"),
      );
    });

    await expect(cursorAdapter.detect(environment)).resolves.toMatchObject({
      metadata: {
        mcpRuntimeStates: {
          "My Server": "ready",
          appsai: "ready",
          context7: "needs-approval",
          docs: "unknown",
          fetch: "disabled",
          filesystem: "error",
          git: "error",
        },
      },
    });
  });

  it("runs the listing from the home directory, never the working directory", async () => {
    const requests: ExecRequest[] = [];
    const environment = environmentWithExec(requests, (request) =>
      request.args?.[0] === "mcp" ? result(0, "docs: ready\n") : result(0, "3.11.0\n"),
    );

    await cursorAdapter.detect(environment);

    // A `.cursor/mcp.json` committed to the repository must not take part: the command connects to
    // whatever it finds, and Aura is routinely pointed at a clone it did not write.
    expect(requests.at(-1)).toEqual({
      args: ["mcp", "list"],
      command: "/first/cursor-agent",
      cwd: "/home/dev",
      timeoutMs: 30_000,
    });
  });

  it("looks for the companion CLI beside the editor before walking the search path", async () => {
    const requests: ExecRequest[] = [];
    const environment = environmentWithExec(requests, (request) =>
      request.command === "/first/cursor"
        ? result(COMMAND_NOT_FOUND_EXIT_CODE)
        : result(0, "3.11.0\n"),
    );

    await cursorAdapter.detect(environment);

    // Resolved beside `/second/cursor` on the first spawn, so no search-path entry is probed for it.
    expect(
      requests
        .filter(
          (request) =>
            request.command.endsWith("cursor-agent") && request.args?.[0] === "--version",
        )
        .map((request) => request.command),
    ).toEqual(["/second/cursor-agent"]);
  });

  it.each([
    ["unverified", result(0, "Cursor Agent\n")],
    ["missing", result(COMMAND_NOT_FOUND_EXIT_CODE)],
  ])("stays quiet for an %s cursor-agent", async (_case, agentResponse) => {
    const requests: ExecRequest[] = [];
    const environment = environmentWithExec(requests, (request) =>
      request.command === "/first/cursor" ? result(0, "3.11.0\n") : agentResponse,
    );

    await expect(cursorAdapter.detect(environment)).resolves.toEqual({
      executablePath: "/first/cursor",
      installed: true,
      version: "3.11.0",
    });
    expect(requests.some((request) => request.args?.[0] === "mcp")).toBe(false);
  });

  it.each([
    ["failure", 2, "failed"],
    ["timeout", TIMEOUT_EXIT_CODE, "timeout"],
  ])("records why the listing produced nothing after a %s", async (_case, exitCode, reason) => {
    const environment = environmentWithExec([], (request) =>
      request.args?.[0] === "mcp" ? result(exitCode, "docs: ready\n") : result(0, "3.11.0\n"),
    );

    await expect(cursorAdapter.detect(environment)).resolves.toMatchObject({
      metadata: { mcpRuntimeStatesUnavailable: reason },
    });
  });

  it("uses cursor-agent.cmd on Windows and records a successful empty list", async () => {
    const requests: ExecRequest[] = [];
    const base = environmentWithExec(requests, (request) =>
      request.command.endsWith(".cmd")
        ? result(0, "3.11.0\n")
        : result(COMMAND_NOT_FOUND_EXIT_CODE),
    );
    const environment: Environment = { ...base, platform: "win32" };

    await expect(cursorAdapter.detect(environment)).resolves.toMatchObject({
      metadata: { mcpRuntimeStates: {} },
    });
    expect(requests.at(-1)?.command).toBe("/first/cursor-agent.cmd");
    expect(requests.at(-1)?.args).toEqual(["mcp", "list"]);
  });
});

describe("Cursor MCP status classification", () => {
  it.each([
    ["ready", "ready"],
    ["Ready to use", "ready"],
    ["already approved", "unknown"],
    ["not ready", "error"],
    ["failed to become ready", "error"],
    ["not loaded (needs approval)", "needs-approval"],
    ["disabled", "disabled"],
    ["something unexpected", "unknown"],
  ])("reads %s as %s", (status, state) => {
    // `ready` is the one state producing no finding, so a status that merely contains the word
    // must not reach it ahead of the failure phrases.
    expect(parseCursorMcpRuntimeStates(`docs: ${status}\n`)).toEqual({ docs: state });
  });

  it("keeps names a JSON key can hold and drops rows that are not a status line", () => {
    expect(
      parseCursorMcpRuntimeStates("My Server: ready\nnaïve-serveur: ready\nno colon here\n"),
    ).toEqual({ "My Server": "ready", "naïve-serveur": "ready" });
  });

  it("caps how many rows third-party output can contribute", () => {
    const rows = Array.from({ length: 250 }, (_value, index) => `server-${index}: ready`).join(
      "\n",
    );

    expect(Object.keys(parseCursorMcpRuntimeStates(rows))).toHaveLength(200);
  });
});

describe("Cursor MCP runtime state contract", () => {
  it("keeps recognized states and drops malformed metadata values", () => {
    const metadata = {
      mcpRuntimeStates: { docs: "needs-approval", future: "paused", malformed: 42 },
    };

    expect(readCursorMcpRuntimeStates(application(metadata))).toEqual({ docs: "needs-approval" });
    expect(parseCursorMcpRuntimeStates("no server row\n")).toEqual({});
  });

  it("reads a recognized unavailability reason and refuses anything else", () => {
    const reasonOf = (metadata: JsonObject): string | undefined =>
      readCursorMcpStateUnavailable(application(metadata));

    expect(reasonOf({ mcpRuntimeStatesUnavailable: "timeout" })).toBe("timeout");
    expect(reasonOf({ mcpRuntimeStatesUnavailable: "elsewhere" })).toBeUndefined();
    expect(reasonOf({})).toBeUndefined();
  });
});

function application(metadata: JsonObject): AppModel {
  return {
    adapterId: "cursor",
    detection: { installed: true, metadata },
    displayName: "Cursor",
    instructionFiles: [],
    mcpServers: [],
    skills: [],
    sourceFiles: [],
    support: { status: "supported", supportedRange: ">=0.45 <4" },
  };
}

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
    httpGet: () => Promise.resolve({ kind: "failure", reason: "network" }),
    now: () => new Date(0),
    pathEntries: ["/first", "/second"],
    platform: "linux",
    readVariable: () => undefined,
  };
}

function result(exitCode: number, stdout = ""): ExecResult {
  return { exitCode, stderr: "", stdout };
}
