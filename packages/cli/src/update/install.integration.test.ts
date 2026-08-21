import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../run.boundary.js";
import { BRANDING, distro } from "../testing.js";
import { tarGzip } from "./tar-fixture.js";
import type { CliDistro, CliRuntime } from "../types.js";
import type { CliUpdates } from "./types.js";

const execFileAsync = promisify(execFile);
const NEXT = "1.4.0";
const ARCHIVE = tarGzip([
  { content: `#!/bin/sh\necho ${NEXT}\n`, name: "acme" },
  { content: "Apache-2.0\n", name: "LICENSE" },
]);
const DIGEST = createHash("sha256").update(ARCHIVE).digest("hex");

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => close(server)));
});

/**
 * The whole chain against loopback fixtures: real metadata narrowing, real streaming download,
 * real tar extraction, a real fork to verify the staged program, and a real rename over the
 * installed one. The only thing standing in for production is the server.
 */
describe("standalone update through runCli", () => {
  it("installs the release and leaves this run on the version it started with", async () => {
    const world = await world1();

    const exitCode = await runCli(world.distro, world.runtime);

    expect(exitCode).toBe(0);
    // The requested command ran, and reported the version this process was compiled as.
    expect(world.stdout()).toBe(`${BRANDING.version}\n`);
    expect(world.stderr()).toBe(
      `Updating ${BRANDING.displayName} ${BRANDING.version} -> ${NEXT}...\n` +
        `Updated ${BRANDING.displayName} to ${NEXT}. The new version will be used on your next run.\n`,
    );

    const next = await execFileAsync(world.executablePath, ["--version"], { encoding: "utf8" });
    expect(next.stdout.trim()).toBe(NEXT);
    expect(await readFile(`${world.executablePath}.previous`, "utf8")).toContain(
      `echo ${BRANDING.version}`,
    );
    expect((await readdir(world.directory)).sort()).toEqual(["acme", "acme.previous"]);
  });

  /**
   * The npm entry point supplies no installation, which is the second of the two gates. Nothing
   * reaches the network, and nothing on disk moves.
   */
  it("makes no request and changes nothing for a package-manager invocation", async () => {
    const world = await world1();
    const runtime: CliRuntime = { ...world.runtime, installation: undefined };

    expect(await runCli(world.distro, runtime)).toBe(0);
    expect(world.requests).toEqual([]);
    expect(world.stderr()).toBe("");
    expect(await readdir(world.directory)).toEqual(["acme"]);
  });

  it("makes no request for a distribution that declares no update source", async () => {
    const world = await world1();
    const withoutUpdates: CliDistro = { ...world.distro, updates: undefined };

    expect(await runCli(withoutUpdates, world.runtime)).toBe(0);
    expect(world.requests).toEqual([]);
    expect(await readdir(world.directory)).toEqual(["acme"]);
  });

  it.each([
    { label: "CI", variables: { CI: "true" } },
    { label: "the disable variable", variables: { ACME_UPDATE: "off" } },
  ])("makes no request when $label is set", async ({ variables }) => {
    const world = await world1();
    const runtime: CliRuntime = {
      ...world.runtime,
      environmentVariables: { ...world.runtime.environmentVariables, ...variables },
    };

    expect(await runCli(world.distro, runtime)).toBe(0);
    expect(world.requests).toEqual([]);
    expect(await readdir(world.directory)).toEqual(["acme"]);
  });

  it("makes no request when the run does not own a terminal", async () => {
    const world = await world1();
    const runtime: CliRuntime = { ...world.runtime, stdin: Readable.from([]) };

    expect(await runCli(world.distro, runtime)).toBe(0);
    expect(world.requests).toEqual([]);
  });

  it("leaves the installed executable alone when the archive is substituted", async () => {
    const world = await world1({ substitute: true });

    expect(await runCli(world.distro, world.runtime)).toBe(0);
    expect(world.stderr()).toContain("did not match the release's published SHA-256 digest");
    expect(await readFile(world.executablePath, "utf8")).toContain(`echo ${BRANDING.version}`);
    expect(await readdir(world.directory)).toEqual(["acme"]);
  });
});

async function world1(options: { readonly substitute?: boolean | undefined } = {}): Promise<{
  readonly directory: string;
  readonly distro: CliDistro;
  readonly executablePath: string;
  readonly requests: string[];
  readonly runtime: CliRuntime;
  readonly stderr: () => string;
  readonly stdout: () => string;
}> {
  const homeDir = await mkdtemp(join(tmpdir(), "aura-update-home-"));
  const directory = await mkdtemp(join(tmpdir(), "aura-update-bin-"));
  const executablePath = join(directory, "acme");
  await writeFile(executablePath, `#!/bin/sh\necho ${BRANDING.version}\n`, { mode: 0o755 });

  // Same length, different bytes: the substitution has to survive the declared-length check so the
  // case that fails is the digest, which is the one that earns a security warning.
  const bytes = options.substitute === true ? substituted() : ARCHIVE;
  const requests: string[] = [];
  const origin = await serve(requests, bytes);
  const updates: CliUpdates = {
    disableEnvironmentVariable: "ACME_UPDATE",
    manualUpdateUrl: "https://example.com/releases",
    source: {
      apiBaseUrl: `${origin}/api`,
      kind: "github-release",
      owner: "acme",
      repository: "acme-cli",
      requireImmutable: true,
    },
  };
  const stderr = capture();
  const stdout = capture();

  return {
    directory,
    distro: { ...distro(), updates },
    executablePath,
    requests,
    runtime: {
      argv: ["--version"],
      cwd: directory,
      environmentVariables: { PATH: "/usr/bin:/bin" },
      homeDir,
      installation: {
        architecture: "arm64",
        executablePath,
        kind: "standalone",
        platform: "darwin",
      },
      setExitCode: () => {},
      stderr: stderr.stream,
      stdin: Object.assign(new PassThrough(), { isTTY: true }),
      stdout: stdout.stream,
    },
    stderr: () => stderr.text(),
    stdout: () => stdout.text(),
  };
}

/** One loopback origin serving both the release document and the archive it names. */
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
        browser_download_url: `${base}/acme/acme-cli/releases/download/v${NEXT}/acme-darwin-arm64.tar.gz`,
        digest: `sha256:${DIGEST}`,
        name: "acme-darwin-arm64.tar.gz",
        size: ARCHIVE.byteLength,
        url: `${base}/api/repos/acme/acme-cli/releases/assets/12`,
      },
    ],
    draft: false,
    immutable: true,
    prerelease: false,
    tag_name: `v${NEXT}`,
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

function capture(): { readonly stream: PassThrough; readonly text: () => string } {
  const chunks: string[] = [];
  const stream = Object.assign(new PassThrough(), { isTTY: true });
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  return { stream, text: () => chunks.join("") };
}
