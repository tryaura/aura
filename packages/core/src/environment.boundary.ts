import { homedir } from "node:os";
import { resolve } from "node:path";

import type { Environment, EnvironmentPlatform } from "@tryaura/aura-sdk";

import { createExec } from "./exec.js";
import { createHttpGet } from "./http.boundary.js";

type EnvironmentVariables = Readonly<Record<string, string | undefined>>;

/** Ambient process state and CLI overrides used to construct Aura's environment at boot. */
export interface EnvironmentBootOptions {
  /** Directory Aura was invoked from. Defaults to `process.cwd()`. */
  readonly cwd?: string | undefined;
  /** Base variables inherited by child processes. Defaults to `process.env`. */
  readonly environmentVariables?: EnvironmentVariables | undefined;
  /** Home directory selected by `--home`. Defaults to the operating-system home. */
  readonly homeDir?: string | undefined;
  /**
   * Network access. Defaults to the bounded TLS-only client; injectable so embedders and test
   * harnesses decide what a run may reach — the testkit pins it to loopback.
   */
  readonly httpGet?: Environment["httpGet"] | undefined;
  /** Clock used by the kernel and plugins. Defaults to the system clock. */
  readonly now?: (() => Date) | undefined;
  /** Delimiter-separated executable search path selected by `--path`. */
  readonly path?: string | undefined;
  /** Host platform. Injectable for platform-independent tests. */
  readonly platform?: EnvironmentPlatform | undefined;
}

/**
 * Captures ambient state once and creates the Environment injected through the Aura kernel.
 *
 * This function is the only production boundary allowed to read process environment, cwd, home,
 * or the system clock. CLI flags are passed as options and replace the corresponding ambient
 * values before the snapshot is created.
 */
export function createEnvironment(options: EnvironmentBootOptions = {}): Environment {
  // Normalized here so every consumer gets the same guarantee `process.cwd()` already gives:
  // absolute, no trailing separator. An embedder supplies this value, and adapters use it both to
  // build paths — where `join` would have hidden the difference — and as a literal lookup key, as
  // Claude Code's per-directory MCP servers are keyed by the directory they were added from.
  const cwd = resolve(options.cwd ?? process.cwd());
  const environmentVariables = copyEnvironmentVariables(
    options.environmentVariables ?? process.env,
  );
  const homeDir = options.homeDir ?? homedir();
  const now = options.now ?? (() => new Date());
  const platform = options.platform ?? readPlatform();
  const path = options.path ?? readPath(environmentVariables, platform);
  const pathEntries = Object.freeze(splitPath(path, platform));
  const childEnvironment = Object.freeze(
    createChildEnvironment(environmentVariables, { homeDir, path, platform }),
  );

  return Object.freeze({
    cwd,
    exec: createExec({ cwd, environmentVariables: childEnvironment, platform }),
    homeDir,
    httpGet: options.httpGet ?? createHttpGet(),
    now,
    pathEntries,
    platform,
    // Reads the boot snapshot, not live process.env, so behavior matches what children inherit.
    // Exact-name lookup: the callers are credential reads whose grammar is uppercase-only.
    readVariable: (name: string) => {
      const value = environmentVariables[name];
      return value === undefined || value === "" ? undefined : value;
    },
  });
}

/**
 * Loader variables that make any subprocess run attacker-chosen code.
 *
 * Aura inherits the ambient environment so commands behave as they do in the developer's shell,
 * but a hijacked loader turns every detection command into an execution vector, so these are
 * dropped rather than forwarded.
 */
const STRIPPED_VARIABLES: readonly string[] = [
  "BASH_ENV",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
];

interface ChildEnvironmentOptions {
  readonly homeDir: string;
  readonly path: string;
  readonly platform: EnvironmentPlatform;
}

function createChildEnvironment(
  environmentVariables: Readonly<Record<string, string>>,
  options: ChildEnvironmentOptions,
): Record<string, string> {
  const childEnvironment: Record<string, string> = { ...environmentVariables };

  const managed = options.platform === "win32" ? WINDOWS_MANAGED : POSIX_MANAGED;
  for (const name of [...STRIPPED_VARIABLES, ...managed]) {
    deleteVariable(childEnvironment, name, options.platform);
  }

  childEnvironment["HOME"] = options.homeDir;
  childEnvironment["PATH"] = options.path;

  if (options.platform === "win32") {
    applyWindowsHome(childEnvironment, options.homeDir);
  }

  return childEnvironment;
}

/** Variables Aura owns rather than inherits, cleared before the canonical values are written. */
const POSIX_MANAGED: readonly string[] = ["HOME", "PATH"];
const WINDOWS_MANAGED: readonly string[] = ["HOME", "HOMEDRIVE", "HOMEPATH", "PATH", "USERPROFILE"];

/** Windows tools read USERPROFILE and HOMEDRIVE/HOMEPATH, so `--home` has to reach those too. */
function applyWindowsHome(childEnvironment: Record<string, string>, homeDir: string): void {
  childEnvironment["USERPROFILE"] = homeDir;

  const drive = /^([A-Za-z]:)(.*)$/.exec(homeDir);
  const root = drive?.[1];
  if (root === undefined) {
    return;
  }

  const rest = drive?.[2];
  childEnvironment["HOMEDRIVE"] = root;
  childEnvironment["HOMEPATH"] = rest === undefined || rest === "" ? "\\" : rest;
}

/**
 * Removes a variable along with any case variant of its name.
 *
 * Windows environment variables are case-insensitive, so leaving an ambient `Path` beside our
 * `PATH` lets the un-overridden value decide how the child resolves executables.
 */
function deleteVariable(
  childEnvironment: Record<string, string>,
  name: string,
  platform: EnvironmentPlatform,
): void {
  if (platform !== "win32") {
    delete childEnvironment[name];
    return;
  }

  for (const key of Object.keys(childEnvironment)) {
    if (key.toUpperCase() === name) {
      delete childEnvironment[key];
    }
  }
}

function copyEnvironmentVariables(
  environmentVariables: EnvironmentVariables,
): Record<string, string> {
  const snapshot: Record<string, string> = {};

  for (const [name, value] of Object.entries(environmentVariables)) {
    if (value !== undefined) {
      snapshot[name] = value;
    }
  }

  return snapshot;
}

function readPath(
  environmentVariables: Readonly<Record<string, string>>,
  platform: EnvironmentPlatform,
): string {
  if (platform === "win32") {
    // Any casing is the same variable on Windows, and `Path` is the usual one.
    const name = Object.keys(environmentVariables).find((key) => key.toUpperCase() === "PATH");
    return name === undefined ? "" : (environmentVariables[name] ?? "");
  }

  return environmentVariables["PATH"] ?? "";
}

function readPlatform(): EnvironmentPlatform {
  switch (process.platform) {
    case "darwin":
    case "linux":
    case "win32": {
      return process.platform;
    }
    default: {
      throw new Error(`Unsupported platform: ${process.platform}`);
    }
  }
}

function splitPath(path: string, platform: EnvironmentPlatform): string[] {
  if (path.length === 0) {
    return [];
  }

  return path.split(platform === "win32" ? ";" : ":");
}
