import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { runCli, runStandaloneCli } from "../run.boundary.js";
import { BRANDING } from "../testing.js";
import {
  closeUpdateServers,
  NEXT_UPDATE_VERSION,
  settledUpdateOutput,
  updateIntegrationWorld,
} from "./install-integration.fixture.js";
import type { CliRuntime } from "../types.js";

const execFileAsync = promisify(execFile);
const createWorld = (options: { readonly substitute?: boolean | undefined } = {}) =>
  updateIntegrationWorld(tmpdir(), options);

afterEach(async () => {
  await closeUpdateServers();
});

/**
 * The whole chain against loopback fixtures: real metadata narrowing, real streaming download,
 * real tar extraction, a real fork to verify the staged program, and a real rename over the
 * installed one. The only thing standing in for production is the server.
 */
describe("standalone update through runStandaloneCli", () => {
  it("installs the release while the requested command completes", async () => {
    const world = await createWorld();

    const exitCode = await runStandaloneCli(
      world.distro,
      world.updates,
      world.current,
      world.runtime,
    );

    expect(exitCode, world.stderr()).toBe(2);
    expect(world.stdout()).not.toBe("");
    // The download frame is painted and erased in between, so the two contract lines are what the
    // user is left looking at. Asserted on the settled screen rather than the raw byte stream,
    // which is the difference between pinning the message and pinning the animation.
    expect(world.stderr()).toContain("Downloading…");
    expect(settledUpdateOutput(world.stderr())).toBe(
      `Updating ${BRANDING.displayName} ${BRANDING.version} -> ${NEXT_UPDATE_VERSION}...\n` +
        `Updated ${BRANDING.displayName} to ${NEXT_UPDATE_VERSION}. The new version will be used on your next run.\n`,
    );

    const next = await execFileAsync(world.executablePath, ["--version"], { encoding: "utf8" });
    expect(next.stdout.trim()).toBe(NEXT_UPDATE_VERSION);
    expect(await readFile(`${world.executablePath}.previous`, "utf8")).toContain(
      `echo ${BRANDING.version}`,
    );
    expect((await readdir(world.directory)).sort()).toEqual(["acme", "acme.previous"]);
  });

  it("checks for an update before an argument-free run", async () => {
    const world = await createWorld();
    const runtime: CliRuntime = { ...world.runtime, argv: [] };

    expect(await runStandaloneCli(world.distro, world.updates, world.current, runtime)).toBe(0);
    expect(world.requests.some((request) => request.includes("/releases/latest"))).toBe(true);
    expect(world.stdout()).toContain(BRANDING.displayName);
  });

  it("bypasses a fresh cache for update and exits without dispatching another command", async () => {
    const world = await createWorld();
    const rootRuntime: CliRuntime = { ...world.runtime, argv: [] };

    expect(await runStandaloneCli(world.distro, world.updates, world.current, rootRuntime)).toBe(0);
    const outputBeforeUpdate = world.stdout();
    world.requests.splice(0);

    const updateRuntime: CliRuntime = { ...world.runtime, argv: ["update"] };
    expect(await runStandaloneCli(world.distro, world.updates, world.current, updateRuntime)).toBe(
      0,
    );
    expect(world.requests).toHaveLength(1);
    expect(world.requests[0]).toContain("/releases/latest");
    expect(world.stdout()).toBe(
      `${outputBeforeUpdate}${BRANDING.displayName} is already up to date.\n`,
    );
  });

  it("reports why an explicit update is unavailable", async () => {
    const world = await createWorld();
    const runtime: CliRuntime = {
      ...world.runtime,
      argv: ["update"],
      environmentVariables: {
        ...world.runtime.environmentVariables,
        ACME_UPDATE: "off",
      },
    };

    expect(await runStandaloneCli(world.distro, world.updates, world.current, runtime)).toBe(2);
    expect(world.requests).toEqual([]);
    expect(world.stderr()).toBe("Acme Doctor updates are disabled by ACME_UPDATE.\n");
  });

  it("reports a failed explicit update check and exits with an operational failure", async () => {
    const world = await createWorld();
    const runtime: CliRuntime = {
      ...world.runtime,
      argv: ["update"],
      httpGet: () => Promise.resolve({ kind: "failure", reason: "network" }),
    };

    expect(await runStandaloneCli(world.distro, world.updates, world.current, runtime)).toBe(3);
    expect(world.requests).toEqual([]);
    expect(world.stderr()).toBe(
      "Acme Doctor could not check for updates. Check your network connection and try again.\n",
    );
  });

  it("uses a failure exit code when an explicit update rejects substituted bytes", async () => {
    const world = await createWorld({ substitute: true });
    const runtime: CliRuntime = { ...world.runtime, argv: ["update"] };

    expect(await runStandaloneCli(world.distro, world.updates, world.current, runtime)).toBe(3);
    expect(world.stderr()).toContain("did not match the release's published SHA-256 digest");
  });

  it("shows update help without making an update request", async () => {
    const world = await createWorld();
    const runtime: CliRuntime = { ...world.runtime, argv: ["update", "--help"] };

    expect(await runStandaloneCli(world.distro, world.updates, world.current, runtime)).toBe(0);
    expect(world.requests).toEqual([]);
    expect(world.stdout()).toContain("acme update — Check for and install an update");
  });

  it("does not delay version output with an update request", async () => {
    const world = await createWorld();
    const runtime: CliRuntime = { ...world.runtime, argv: ["--version"] };

    expect(await runStandaloneCli(world.distro, world.updates, world.current, runtime)).toBe(0);
    expect(world.stdout()).toBe(`${BRANDING.version}\n`);
    expect(world.requests).toEqual([]);
    expect(await readdir(world.directory)).toEqual(["acme"]);
  });

  /**
   * The npm entry point calls `runCli`, whose signature carries no updater capability. Nothing
   * reaches the network, and nothing on disk moves.
   */
  it("makes no request and changes nothing for a package-manager invocation", async () => {
    const world = await createWorld();
    expect(await runCli(world.distro, world.runtime)).toBe(2);
    expect(world.requests).toEqual([]);
    expect(await readdir(world.directory)).toEqual(["acme"]);
  });

  it.each([
    { label: "CI", variables: { CI: "true" } },
    { label: "the disable variable", variables: { ACME_UPDATE: "off" } },
  ])("makes no request when $label is set", async ({ variables }) => {
    const world = await createWorld();
    const runtime: CliRuntime = {
      ...world.runtime,
      environmentVariables: { ...world.runtime.environmentVariables, ...variables },
    };

    expect(await runStandaloneCli(world.distro, world.updates, world.current, runtime)).toBe(2);
    expect(world.requests).toEqual([]);
    expect(await readdir(world.directory)).toEqual(["acme"]);
  });

  it("makes no request when the run does not own a terminal", async () => {
    const world = await createWorld();
    const runtime: CliRuntime = { ...world.runtime, stdin: Readable.from([]) };

    expect(await runStandaloneCli(world.distro, world.updates, world.current, runtime)).toBe(2);
    expect(world.requests).toEqual([]);
  });

  it("leaves the installed executable alone when the archive is substituted", async () => {
    const world = await createWorld({ substitute: true });

    expect(await runStandaloneCli(world.distro, world.updates, world.current, world.runtime)).toBe(
      2,
    );
    expect(world.stderr()).toContain("did not match the release's published SHA-256 digest");
    expect(await readFile(world.executablePath, "utf8")).toContain(`echo ${BRANDING.version}`);
    expect(await readdir(world.directory)).toEqual(["acme"]);
  });
});
