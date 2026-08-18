import { posix, win32 } from "node:path";

import { type Environment, type McpProbeResult, type McpServer } from "@tryaura/aura-sdk";

import { createLimiter } from "./concurrency.js";
import type { McpUrlRequest, McpUrlRequestInput, McpUrlResponse } from "./mcp-url-request.js";
import type { FileReader } from "./reader.js";

export type { McpUrlRequest } from "./mcp-url-request.js";

const MAX_CONCURRENT_URL_PROBES = 8;
const MAX_DETAIL_CHARACTERS = 300;
const MAX_REDIRECTS = 3;
const URL_PROBE_TIMEOUT_MS = 3_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const PACKAGE_RUNNERS = new Set(["bunx", "npx", "uvx"]);

export interface McpProbeOptions {
  readonly environment: Environment;
  readonly online: boolean;
  readonly reader: FileReader;
  readonly urlRequest?: McpUrlRequest | undefined;
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
                  limitUrl(() => urlProbe(transport.url, options)),
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
    return (await anyExists(executableCandidates(command, environment), reader))
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
    if (await anyExists(executableCandidates(candidate, environment), reader)) {
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

async function anyExists(paths: readonly string[], reader: FileReader): Promise<boolean> {
  for (const path of paths) {
    if (await reader.exists(path)) {
      return true;
    }
  }
  return false;
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

async function urlProbe(url: string, options: McpProbeOptions): Promise<McpProbeResult> {
  if (!options.online) {
    return {
      detail: "URL reachability was not checked because online probing was not enabled.",
      kind: "url",
      status: "unavailable",
    };
  }
  if (options.urlRequest === undefined) {
    return {
      detail: "URL reachability could not be checked because no network requester is available.",
      kind: "url",
      status: "unavailable",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), URL_PROBE_TIMEOUT_MS);
  const redirects = { count: 0 };
  try {
    const head = await requestFollowingRedirects(
      url,
      "HEAD",
      controller.signal,
      redirects,
      options.urlRequest,
    );
    const response =
      head.status === 405
        ? await requestFollowingRedirects(
            head.url,
            "GET",
            controller.signal,
            redirects,
            options.urlRequest,
          )
        : head;
    return responseProblem(response.status);
  } catch (error) {
    return {
      detail: controller.signal.aborted
        ? "The URL probe timed out after 3 seconds."
        : boundedDetail(error),
      kind: "url",
      status: "error",
    };
  } finally {
    clearTimeout(timeout);
  }
}

interface FollowedResponse extends McpUrlResponse {
  readonly url: string;
}

async function requestFollowingRedirects(
  initialUrl: string,
  method: McpUrlRequestInput["method"],
  signal: AbortSignal,
  redirects: { count: number },
  request: McpUrlRequest,
): Promise<FollowedResponse> {
  let url = initialUrl;
  while (true) {
    const response = await request({ method, signal, url });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { ...response, url };
    }
    if (redirects.count >= MAX_REDIRECTS) {
      throw new Error("The URL exceeded Aura's limit of 3 redirects.");
    }
    if (response.location === undefined) {
      throw new Error(
        `The URL returned redirect status ${String(response.status)} without a location.`,
      );
    }
    redirects.count += 1;
    url = new URL(response.location, url).toString();
  }
}

function responseProblem(status: number): McpProbeResult {
  return status === 404 || status >= 500
    ? {
        detail: `The URL responded with HTTP ${String(status)}.`,
        kind: "url",
        status: "error",
      }
    : { kind: "url", status: "ok" };
}

function boundedDetail(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    if (current.message !== "" && !messages.includes(current.message)) {
      messages.push(current.message);
    }
    current = "cause" in current ? current.cause : undefined;
  }
  const detail = messages.length === 0 ? String(error) : messages.join(": ");
  return detail.length <= MAX_DETAIL_CHARACTERS
    ? detail
    : `${detail.slice(0, MAX_DETAIL_CHARACTERS)}…`;
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
