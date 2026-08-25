import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import type { HttpGetRequest } from "@tryaura/aura-sdk";

import { sourceIdentity } from "./provider.js";
import { tarGzip } from "./tar-fixture.js";
import type { UpdateDownloadRequest, UpdateHost } from "./host.js";
import type { StartupUpdateRequest } from "./run.js";
import type { CliBranding } from "../types.js";
import type { CliUpdates } from "./types.js";

/**
 * One whole distribution wired to fakes: a real executable on disk, a canned release document, and
 * a download that moves prepared bytes rather than opening a socket.
 *
 * Shared rather than duplicated, because the suites that need it — the message contract and the
 * startup budget — assert different things about the same run, and a second copy of this harness
 * is how the two drift into testing different distributions.
 */

export const NOW = new Date("2026-08-21T12:00:00.000Z");

export const BRANDING: CliBranding = {
  command: "acme",
  displayName: "Acme Doctor",
  docsUrl: "https://example.com/docs",
  version: "1.3.0",
};

const UPDATES: CliUpdates = {
  kind: "github-release",
  manualUpdateUrl: "https://example.com/releases",
  owner: "acme",
  repository: "acme-cli",
};

export const IDENTITY = sourceIdentity(UPDATES, BRANDING.command);
const ARCHIVE = tarGzip([{ content: "VERSION=1.4.0\n", name: "acme" }]);
const DIGEST = createHash("sha256").update(ARCHIVE).digest("hex");

export interface StartupScenario {
  /** Every archive download the run asked for, so a caller can read the budget it was given. */
  readonly downloads: UpdateDownloadRequest[];
  readonly executablePath: string;
  readonly homeDir: string;
  readonly request: StartupUpdateRequest;
  readonly requests: HttpGetRequest[];
  readonly stderr: () => string;
  readonly stdout: () => string;
}

export interface StartupScenarioOptions {
  readonly corrupt?: boolean | undefined;
  readonly environmentVariables?: Readonly<Record<string, string | undefined>> | undefined;
  readonly httpFailure?: boolean | undefined;
  /** Wall clock the run reads, so a case can spend part of the budget before the install starts. */
  readonly now?: (() => Date) | undefined;
  readonly tag?: string | undefined;
}

export async function scenario(options: StartupScenarioOptions = {}): Promise<StartupScenario> {
  const homeDir = await mkdtemp(join(tmpdir(), "aura-startup-home-"));
  const directory = await mkdtemp(join(tmpdir(), "aura-startup-bin-"));
  const executablePath = join(directory, "acme");
  await writeFile(executablePath, "VERSION=1.3.0\n", { mode: 0o755 });

  const requests: HttpGetRequest[] = [];
  const downloads: UpdateDownloadRequest[] = [];
  const stderr = captureUpdateTerminal();
  const stdout = captureUpdateTerminal();

  return {
    downloads,
    executablePath,
    homeDir,
    request: {
      argv: ["check"],
      branding: BRANDING,
      current: { arch: "arm64", execPath: executablePath, platform: "darwin" },
      environmentVariables: options.environmentVariables ?? {},
      homeDir,
      host: host(options.corrupt === true, downloads),
      httpGet: (request) => {
        requests.push(request);
        return Promise.resolve(
          options.httpFailure === true
            ? { kind: "failure", reason: "network" }
            : { body: release(options.tag ?? "v1.4.0"), kind: "response", status: 200 },
        );
      },
      now: options.now ?? (() => NOW),
      stderr: stderr.stream,
      stdin: terminal(),
      stdout: stdout.stream,
      updates: UPDATES,
    },
    requests,
    stderr: () => stderr.text(),
    stdout: () => stdout.text(),
  };
}

function release(tag: string): string {
  return JSON.stringify({
    assets: [
      {
        browser_download_url: `https://github.com/acme/acme-cli/releases/download/${tag}/acme-darwin-arm64.tar.gz`,
        digest: `sha256:${DIGEST}`,
        name: "acme-darwin-arm64.tar.gz",
        size: ARCHIVE.byteLength,
        url: "https://api.github.com/repos/acme/acme-cli/releases/assets/12",
      },
    ],
    draft: false,
    immutable: true,
    prerelease: false,
    tag_name: tag,
  });
}

function host(corrupt: boolean, downloads: UpdateDownloadRequest[]): UpdateHost {
  const bytes = corrupt ? tarGzip([{ content: "VERSION=6.6.6\n", name: "acme" }]) : ARCHIVE;
  return {
    download: async (request) => {
      downloads.push(request);
      await writeFile(request.destinationPath, bytes, { flag: "wx" });
      return { kind: "downloaded", sha256: createHash("sha256").update(bytes).digest("hex") };
    },
    isProcessAlive: () => false,
    pid: 4_242,
    probeVersion: async (path) => {
      const contents = await readFile(path, "utf8").catch(() => "");
      return /^VERSION=(?<version>.+)$/mu.exec(contents)?.groups?.["version"];
    },
  };
}

function terminal(): PassThrough {
  return Object.assign(new PassThrough(), { isTTY: true });
}

export function captureUpdateTerminal(): {
  readonly stream: PassThrough;
  readonly text: () => string;
} {
  const chunks: string[] = [];
  const stream = Object.assign(new PassThrough(), { isTTY: true });
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  return { stream, text: () => chunks.join("") };
}
