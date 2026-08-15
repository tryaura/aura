import type { Environment } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { createEnvironment, type EnvironmentBootOptions } from "./index.js";

/** Runs a command that prints the environment it was given, so assertions see what a child sees. */
async function readChildEnvironment(environment: Environment): Promise<Record<string, string>> {
  const result = await environment.exec({
    args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
    command: process.execPath,
  });

  expect(result.exitCode).toBe(0);
  const parsed: unknown = JSON.parse(result.stdout);
  const childEnvironment: Record<string, string> = {};
  if (typeof parsed !== "object" || parsed === null) {
    return childEnvironment;
  }

  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      childEnvironment[name] = value;
    }
  }

  return childEnvironment;
}

describe("createEnvironment", () => {
  it("uses explicit boot values and snapshots PATH entries", () => {
    const fixedNow = new Date("2026-08-15T00:00:00.000Z");
    const environmentVariables: Record<string, string | undefined> = {
      KEEP: "captured",
      PATH: "/ambient/bin",
    };
    const options: EnvironmentBootOptions = {
      cwd: "/workspace",
      environmentVariables,
      homeDir: "/fake/home",
      now: () => fixedNow,
      path: "/fake/one:/fake/two",
      platform: "linux",
    };
    const environment = createEnvironment(options);

    environmentVariables["PATH"] = "/changed/bin";

    expect(environment).toMatchObject({
      cwd: "/workspace",
      homeDir: "/fake/home",
      pathEntries: ["/fake/one", "/fake/two"],
      platform: "linux",
    });
    expect(environment.now()).toBe(fixedNow);
    expect(Object.isFrozen(environment)).toBe(true);
    expect(Object.isFrozen(environment.pathEntries)).toBe(true);
  });

  it("uses the platform delimiter and case-compatible PATH on Windows", () => {
    const environment = createEnvironment({
      cwd: "C:\\workspace",
      environmentVariables: { Path: "C:\\one;D:\\two" },
      homeDir: "C:\\Users\\aura",
      platform: "win32",
    });

    expect(environment.pathEntries).toEqual(["C:\\one", "D:\\two"]);
  });

  it("leaves a single PATH and home variable in the child environment on Windows", async () => {
    // Windows resolves environment variables case-insensitively, so an ambient `Path` left beside
    // our `PATH` would decide how the child resolves executables.
    const environment = createEnvironment({
      // A real directory: the child has to start for its environment to be observable.
      cwd: "/",
      environmentVariables: {
        HOMEPATH: "\\Users\\ambient",
        Path: "C:\\ambient",
        userprofile: "C:\\Users\\ambient",
      },
      homeDir: "C:\\Users\\aura",
      path: "C:\\override",
      platform: "win32",
    });

    const childEnvironment = await readChildEnvironment(environment);

    expect(Object.keys(childEnvironment).filter((key) => key.toUpperCase() === "PATH")).toEqual([
      "PATH",
    ]);
    expect(childEnvironment["PATH"]).toBe("C:\\override");
    expect(childEnvironment["USERPROFILE"]).toBe("C:\\Users\\aura");
    expect(childEnvironment["HOME"]).toBe("C:\\Users\\aura");
    expect(childEnvironment["HOMEDRIVE"]).toBe("C:");
    expect(childEnvironment["HOMEPATH"]).toBe("\\Users\\aura");
  });

  it("strips loader variables that would inject code into every command", async () => {
    const environment = createEnvironment({
      cwd: "/",
      environmentVariables: {
        DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
        KEEP: "inherited",
        LD_PRELOAD: "/tmp/evil.so",
        NODE_OPTIONS: "--require /tmp/evil.js",
      },
      homeDir: "/fake/home",
      path: "",
      platform: "linux",
    });

    const childEnvironment = await readChildEnvironment(environment);

    expect(childEnvironment["NODE_OPTIONS"]).toBeUndefined();
    expect(childEnvironment["LD_PRELOAD"]).toBeUndefined();
    expect(childEnvironment["DYLD_INSERT_LIBRARIES"]).toBeUndefined();
    expect(childEnvironment["KEEP"]).toBe("inherited");
  });

  it("represents a missing PATH as no search entries", () => {
    const environment = createEnvironment({
      cwd: "/workspace",
      environmentVariables: {},
      homeDir: "/fake/home",
      platform: "darwin",
    });

    expect(environment.pathEntries).toEqual([]);
  });
});
