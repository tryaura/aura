import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { describe, expect, it } from "vitest";

import { installUpdate, type InstallOutcome } from "./install.js";
import { tarGzip, type TarFixtureEntry } from "./tar-fixture.js";
import type { UpdateDownloadResult, UpdateHost } from "./host.js";
import type { CliUpdateCandidate } from "./types.js";

const NOW = Date.parse("2026-08-21T12:00:00.000Z");
const COMMAND = "acme";
const INSTALLED = "VERSION=1.3.0\n";

describe("update installation transaction", () => {
  it("replaces the executable and keeps one recovery copy", async () => {
    const world = await world1();

    expect(await install(world)).toEqual({ kind: "installed" });
    expect(await readFile(world.executablePath, "utf8")).toBe("VERSION=1.4.0\n");
    expect(await readFile(`${world.executablePath}.previous`, "utf8")).toBe(INSTALLED);
    expect((await stat(world.executablePath)).mode & 0o777).toBe(0o755);
  });

  it("leaves no temporary files behind", async () => {
    const world = await world1();
    await install(world);

    expect((await readdir(world.directory)).sort()).toEqual(["acme", "acme.previous"]);
  });

  /**
   * The bytes were not the ones the release published a digest for. This is the outcome that gets
   * an explicit security warning, and the one where the installed executable must be provably
   * untouched.
   */
  it("refuses bytes that do not match the published digest", async () => {
    const world = await world1({ candidate: { sha256: "f".repeat(64) } });

    expect(await install(world)).toEqual({ kind: "refused" });
    expect(await readFile(world.executablePath, "utf8")).toBe(INSTALLED);
    expect(await readdir(world.directory)).toEqual(["acme"]);
  });

  /**
   * A digest proves the bytes match a release; running the program proves the release is the one
   * the metadata named and that it starts on this machine at all.
   */
  it("refuses a staged program that reports a different version", async () => {
    const world = await world1({ staged: "VERSION=9.9.9\n" });

    expect(await install(world)).toEqual({ kind: "failed" });
    expect(await readFile(world.executablePath, "utf8")).toBe(INSTALLED);
  });

  it.each([
    { entries: [{ content: "Apache-2.0\n", name: "LICENSE" }], label: "carries no executable" },
    { entries: [{ content: "x\n", name: "payload.sh" }], label: "carries an unexpected file" },
  ])("refuses an archive that $label", async ({ entries }) => {
    const world = await world1({ entries });

    expect(await install(world)).toEqual({ kind: "failed" });
    expect(await readFile(world.executablePath, "utf8")).toBe(INSTALLED);
  });

  it("reports a download that never produced bytes as a plain failure", async () => {
    const world = await world1();
    const outcome = await install(world, {
      download: () => Promise.resolve({ kind: "failure", reason: "network" }),
    });

    expect(outcome).toEqual({ kind: "failed" });
    expect(await readFile(world.executablePath, "utf8")).toBe(INSTALLED);
  });

  it("says nothing and changes nothing while another updater holds the lock", async () => {
    const world = await world1();
    await writeFile(
      `${world.executablePath}.update-lock`,
      JSON.stringify({ pid: 1, startedAt: NOW }),
    );

    expect(await install(world)).toEqual({ kind: "skipped" });
    expect(await readFile(world.executablePath, "utf8")).toBe(INSTALLED);
  });

  /**
   * Re-asked under the lock, because another updater may have finished between this run's
   * eligibility check and this moment. Installing again would point the recovery copy at itself.
   */
  it("stops when the installed executable is already the candidate", async () => {
    const world = await world1();
    await writeFile(world.executablePath, "VERSION=1.4.0\n", { mode: 0o755 });

    expect(await install(world)).toEqual({ kind: "skipped" });
  });

  it("updates a license the installation already keeps", async () => {
    const world = await world1();
    await writeFile(join(world.directory, "LICENSE"), "old license\n");

    expect(await install(world)).toEqual({ kind: "installed" });
    expect(await readFile(join(world.directory, "LICENSE"), "utf8")).toBe("Apache-2.0\n");
  });

  it("still installs when the archive carries no license", async () => {
    const world = await world1({ entries: [{ content: "VERSION=1.4.0\n", name: COMMAND }] });
    await writeFile(join(world.directory, "LICENSE"), "old license\n");

    expect(await install(world)).toEqual({ kind: "installed" });
    expect(await readFile(world.executablePath, "utf8")).toBe("VERSION=1.4.0\n");
    expect(await readFile(join(world.directory, "LICENSE"), "utf8")).toBe("old license\n");
  });

  it("does not create a license the installation never had", async () => {
    const world = await world1();
    await install(world);

    expect(await readdir(world.directory)).not.toContain("LICENSE");
  });

  it("downloads and replaces once when two updaters race", async () => {
    const world = await world1();
    let downloads = 0;
    const counting = {
      download: async (request: Parameters<UpdateHost["download"]>[0]) => {
        downloads += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return await host(world).download(request);
      },
    };

    const outcomes = await Promise.all([install(world, counting), install(world, counting)]);

    expect(downloads).toBe(1);
    expect(outcomes.filter((outcome) => outcome.kind === "installed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === "skipped")).toHaveLength(1);
    expect(await readFile(world.executablePath, "utf8")).toBe("VERSION=1.4.0\n");
  });

  /**
   * A directory the user cannot write to is the ordinary case for `/usr/local/bin`. The update
   * fails, and the executable that is already there keeps working.
   */
  it.skipIf(process.getuid?.() === 0)("fails without damage in a read-only directory", async () => {
    const world = await world1();
    await chmod(world.directory, 0o500);
    try {
      expect(await install(world)).toEqual({ kind: "failed" });
      expect(await readFile(world.executablePath, "utf8")).toBe(INSTALLED);
    } finally {
      await chmod(world.directory, 0o700);
    }
  });
});

interface World {
  readonly archive: Buffer;
  readonly candidate: CliUpdateCandidate;
  readonly directory: string;
  readonly executablePath: string;
}

async function world1(
  options: {
    readonly candidate?: Partial<CliUpdateCandidate["archive"]> | undefined;
    readonly entries?: readonly TarFixtureEntry[] | undefined;
    readonly staged?: string | undefined;
  } = {},
): Promise<World> {
  const directory = await mkdtemp(join(tmpdir(), "aura-update-install-"));
  const executablePath = join(directory, COMMAND);
  await writeFile(executablePath, INSTALLED, { mode: 0o755 });

  const archive = tarGzip(
    options.entries ?? [
      { content: options.staged ?? "VERSION=1.4.0\n", name: COMMAND },
      { content: "Apache-2.0\n", name: "LICENSE" },
    ],
  );
  return {
    archive,
    candidate: {
      archive: {
        downloadUrl: "https://github.com/acme/acme-cli/releases/download/v1.4.0/acme.tar.gz",
        sha256: createHash("sha256").update(archive).digest("hex"),
        size: archive.byteLength,
        ...options.candidate,
      },
      version: "1.4.0",
    },
    directory,
    executablePath,
  };
}

function install(world: World, overrides: Partial<UpdateHost> = {}): Promise<InstallOutcome> {
  return installUpdate({
    candidate: world.candidate,
    command: COMMAND,
    downloadHeaders: {},
    executablePath: world.executablePath,
    host: { ...host(world), ...overrides },
    now: NOW,
    probeEnvironment: {},
  });
}

/**
 * A host that moves prepared bytes onto disk and reads a version out of a file.
 *
 * Deliberately not a real network or a real fork: what these cases are about is the order of the
 * filesystem operations, and both real capabilities are covered by their own suites.
 */
function host(world: World): UpdateHost {
  return {
    download: async (request): Promise<UpdateDownloadResult> => {
      await writeFile(request.destinationPath, world.archive, { flag: "wx" });
      return {
        kind: "downloaded",
        sha256: createHash("sha256").update(world.archive).digest("hex"),
      };
    },
    isProcessAlive: () => true,
    pid: 4_242,
    probeVersion: async (executablePath) => {
      const contents = await readFile(executablePath, "utf8").catch(() => "");
      return /^VERSION=(?<version>.+)$/mu.exec(contents)?.groups?.["version"];
    },
  };
}
