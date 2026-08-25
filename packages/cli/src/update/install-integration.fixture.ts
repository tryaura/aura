import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { eraseFrame } from "../terminal-frame.js";
import { BRANDING, distro } from "../testing.js";
import { tarGzip } from "./tar-fixture.js";
import { captureUpdateTerminal } from "./testing.js";
import type { CliDistro, CliRuntime } from "../types.js";
import type { CliUpdates } from "./types.js";

export const NEXT_UPDATE_VERSION = "1.4.0";
const ARCHIVE = tarGzip([
  { content: `#!/bin/sh\necho ${NEXT_UPDATE_VERSION}\n`, name: "acme" },
  { content: "Apache-2.0\n", name: "LICENSE" },
]);
const DIGEST = createHash("sha256").update(ARCHIVE).digest("hex");
const servers: Server[] = [];

export interface UpdateIntegrationWorld {
  readonly directory: string;
  readonly current: Pick<NodeJS.Process, "arch" | "execPath" | "platform">;
  readonly distro: CliDistro;
  readonly executablePath: string;
  readonly requests: string[];
  readonly runtime: CliRuntime;
  readonly stderr: () => string;
  readonly stdout: () => string;
  readonly updates: CliUpdates;
}

export async function updateIntegrationWorld(
  temporaryDirectory: string,
  options: { readonly substitute?: boolean | undefined } = {},
): Promise<UpdateIntegrationWorld> {
  const homeDir = await mkdtemp(join(temporaryDirectory, "aura-update-home-"));
  const directory = await mkdtemp(join(temporaryDirectory, "aura-update-bin-"));
  const executablePath = join(directory, "acme");
  await writeFile(executablePath, `#!/bin/sh\necho ${BRANDING.version}\n`, { mode: 0o755 });

  const bytes = options.substitute === true ? substituted() : ARCHIVE;
  const requests: string[] = [];
  const origin = await serve(requests, bytes);
  const stderr = captureUpdateTerminal();
  const stdout = captureUpdateTerminal();
  return {
    directory,
    current: { arch: "arm64", execPath: executablePath, platform: "darwin" },
    distro: distro(),
    executablePath,
    requests,
    runtime: {
      argv: ["check", "--json"],
      cwd: directory,
      environmentVariables: { PATH: "/usr/bin:/bin" },
      homeDir,
      setExitCode: () => {},
      stderr: stderr.stream,
      stdin: Object.assign(new PassThrough(), { isTTY: true }),
      stdout: stdout.stream,
    },
    stderr: () => stderr.text(),
    stdout: () => stdout.text(),
    updates: {
      apiBaseUrl: `${origin}/api`,
      kind: "github-release",
      manualUpdateUrl: "https://example.com/releases",
      owner: "acme",
      repository: "acme-cli",
    },
  };
}

export async function closeUpdateServers(): Promise<void> {
  await Promise.all(servers.splice(0).map((server) => close(server)));
}

/** Returns the terminal contents after applying the updater's frame erasures. */
export function settledUpdateOutput(raw: string): string {
  const erase = eraseFrame(1);
  const lines = [""];
  for (const [index, part] of raw.split(erase).entries()) {
    if (index > 0) {
      lines.splice(Math.max(0, lines.length - 2));
      lines.push("");
    }
    const [head = "", ...rest] = part.split("\n");
    lines[lines.length - 1] += head;
    lines.push(...rest);
  }
  return lines.join("\n");
}

async function serve(requests: string[], bytes: Buffer): Promise<string> {
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url?.endsWith(".tar.gz") === true) {
      response.writeHead(200, { "content-length": String(bytes.byteLength) });
      response.end(bytes);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(releaseDocument(server));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return origin(server);
}

function releaseDocument(server: Server): string {
  const base = origin(server);
  return JSON.stringify({
    assets: [
      {
        browser_download_url: `${base}/acme/acme-cli/releases/download/v${NEXT_UPDATE_VERSION}/acme-darwin-arm64.tar.gz`,
        digest: `sha256:${DIGEST}`,
        name: "acme-darwin-arm64.tar.gz",
        size: ARCHIVE.byteLength,
        url: `${base}/api/repos/acme/acme-cli/releases/assets/12`,
      },
    ],
    draft: false,
    immutable: true,
    prerelease: false,
    tag_name: `v${NEXT_UPDATE_VERSION}`,
  });
}

function substituted(): Buffer {
  const bytes = Buffer.from(ARCHIVE);
  const last = bytes.byteLength - 1;
  bytes[last] = (bytes[last] ?? 0) ^ 0xff;
  return bytes;
}

function origin(server: Server): string {
  const address = server.address();
  return typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : "";
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}
