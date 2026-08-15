import { describe, expect, it } from "vitest";

import { COMMAND_NOT_FOUND_EXIT_CODE, type ExecRequest, type ExecResult } from "./environment.js";
import type { Environment, EnvironmentPlatform } from "./environment.js";
import { detectExecutable } from "./detect.js";

const OPTIONS = { authenticationArgs: ["auth", "status"], binaryName: "agent" };

describe("executable detection", () => {
  it("walks the path until a candidate reports a version, then probes authentication", async () => {
    const requests: ExecRequest[] = [];
    const environment = environmentWithExec(requests, (request) => {
      if (request.command === "/first/agent") {
        return result(COMMAND_NOT_FOUND_EXIT_CODE);
      }
      return request.args?.[0] === "--version" ? result(0, "agent 1.2.3\n") : result(0);
    });

    await expect(detectExecutable(environment, OPTIONS)).resolves.toEqual({
      authenticated: true,
      executablePath: "/second/agent",
      installed: true,
      version: "1.2.3",
    });
    expect(requests.map((request) => [request.command, ...(request.args ?? [])])).toEqual([
      ["/first/agent", "--version"],
      ["/second/agent", "--version"],
      ["/second/agent", "auth", "status"],
    ]);
  });

  it.each([
    [0, true],
    [1, false],
    [2, undefined],
  ])("maps authentication exit %i to %s", async (exitCode, authenticated) => {
    const environment = environmentWithExec([], (request) =>
      request.args?.[0] === "--version" ? result(0, "agent 1.2.3\n") : result(exitCode),
    );

    const detection = await detectExecutable(environment, OPTIONS);
    expect(detection.authenticated).toBe(authenticated);
  });

  it("reports the executable absent after probing each entry once", async () => {
    const requests: ExecRequest[] = [];
    const base = environmentWithExec(requests, () => result(COMMAND_NOT_FOUND_EXIT_CODE));
    const environment: Environment = {
      ...base,
      pathEntries: ["relative", "/absolute", "/absolute"],
    };

    await expect(detectExecutable(environment, OPTIONS)).resolves.toEqual({ installed: false });
    expect(requests.map((request) => request.command)).toEqual(["/absolute/agent"]);
  });

  it("uses the Windows executable name", async () => {
    const requests: ExecRequest[] = [];
    const environment = environmentWithExec(
      requests,
      () => result(COMMAND_NOT_FOUND_EXIT_CODE),
      "win32",
    );

    await detectExecutable(environment, OPTIONS);
    expect(requests[0]?.command).toBe("/first/agent.exe");
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

function result(exitCode: number, stdout = ""): ExecResult {
  return { exitCode, stderr: "", stdout };
}
