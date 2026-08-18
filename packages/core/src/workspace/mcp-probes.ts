import { posix, win32 } from "node:path";

import { type Environment, type McpProbeResult, type McpServer } from "@tryaura/aura-sdk";

import { createLimiter } from "./concurrency.js";
import { probeMcpUrl } from "./mcp-url-probe.js";
import type { McpUrlRequest } from "./mcp-url-request.js";
import type { FileReader } from "./reader.js";

const MAX_CONCURRENT_URL_PROBES = 8;
const PACKAGE_RUNNERS = new Set(["bunx", "npx", "uvx"]);

/** What a scan turns on when it asks for probes. */
export interface McpProbeSettings {
  /**
   * Transport for remote reachability checks.
   *
   * Its presence is what enables network probing, so an online scan with no way to make a request
   * cannot be expressed.
   */
  readonly urlRequest?: McpUrlRequest | undefined;
}

export interface McpProbeOptions extends McpProbeSettings {
  readonly environment: Environment;
  readonly reader: FileReader;
}

export type McpProber = (servers: readonly McpServer[]) => Promise<readonly McpServer[]>;

/** Adds core-owned probe results without trusting or retaining probe data supplied by an adapter. */
export function createMcpProber(options: McpProbeOptions): McpProber {
  const limitUrl = createLimiter(MAX_CONCURRENT_URL_PROBES);
  const urls = new Map<string, Promise<McpProbeResult>>();

  return (servers) =>
    Promise.all(
      servers.map(async (server): Promise<McpServer> => {
        const transport = server.transport;
        const probes =
          transport.type === "stdio"
            ? await stdioProbes(transport.command, options)
            : [
                await memoize(urls, transport.url, () =>
                  limitUrl(() => probeMcpUrl(transport.url, options.urlRequest)),
                ),
              ];
        return Object.freeze({ ...server, probes: Object.freeze(probes) });
      }),
    );
}

async function stdioProbes(
  command: string,
  options: McpProbeOptions,
): Promise<readonly McpProbeResult[]> {
  const commandResult = await commandProbe(command, options.environment, options.reader);
  const runner = commandBaseName(command, options.environment);
  if (!PACKAGE_RUNNERS.has(runner)) {
    return [commandResult];
  }
  return [
    commandResult,
    commandResult.status === "ok"
      ? {
          detail:
            "Aura verifies the package runner but does not guess whether its requested package is installed or cached.",
          kind: "package",
          status: "unknown",
        }
      : {
          detail: "The package cannot be checked because its runner is unavailable.",
          kind: "package",
          status: "unavailable",
        },
  ];
}

async function commandProbe(
  command: string,
  environment: Environment,
  reader: FileReader,
): Promise<McpProbeResult> {
  if (command.trim() === "") {
    return missingCommand("(empty command)");
  }
  const paths = environment.platform === "win32" ? win32 : posix;
  if (paths.isAbsolute(command)) {
    return (await anyExecutable(executableCandidates(command, environment), reader))
      ? { kind: "command", status: "ok" }
      : missingCommand(command);
  }
  if (pathLike(command)) {
    return {
      detail: `Aura cannot safely resolve relative command ${command} without knowing the application's launch directory.`,
      kind: "command",
      status: "unsupported",
    };
  }

  const directories = [
    ...new Set(environment.pathEntries.filter((entry) => paths.isAbsolute(entry))),
  ];
  for (const directory of directories) {
    const candidate = paths.join(directory, command);
    if (await anyExecutable(executableCandidates(candidate, environment), reader)) {
      return { kind: "command", status: "ok" };
    }
  }
  return missingCommand(command);
}

function executableCandidates(path: string, environment: Environment): readonly string[] {
  if (environment.platform !== "win32" || win32.extname(path) !== "") {
    return [path];
  }
  return [path, `${path}.com`, `${path}.exe`, `${path}.bat`, `${path}.cmd`];
}

async function anyExecutable(paths: readonly string[], reader: FileReader): Promise<boolean> {
  for (const path of paths) {
    if (await isExecutableFile(path, reader)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a path is something an application could actually launch.
 *
 * Mere presence is not enough: a directory named `npx` on the search path is not a runner, and a
 * symlink left dangling by an uninstalled toolchain is exactly the failure this check exists to
 * report. Resolution comes first so both reduce to "there is nothing to run".
 */
async function isExecutableFile(path: string, reader: FileReader): Promise<boolean> {
  const resolved = await reader.realPath(path);
  if (resolved === undefined) {
    return false;
  }
  const inspected = await (reader.inspect === undefined
    ? reader.read(resolved)
    : reader.inspect(resolved));
  return inspected.exists && !inspected.isDirectory;
}

function missingCommand(command: string): McpProbeResult {
  return {
    detail: `Command ${command} was not found on the configured executable search path.`,
    kind: "command",
    status: "error",
  };
}

function pathLike(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function commandBaseName(command: string, environment: Environment): string {
  const paths = environment.platform === "win32" ? win32 : posix;
  const extension = environment.platform === "win32" ? paths.extname(command) : "";
  return paths.basename(command, extension).toLowerCase();
}

async function memoize<T>(
  values: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const existing = values.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const loaded = load();
  values.set(key, loaded);
  return loaded;
}
