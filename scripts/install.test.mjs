/* eslint-disable no-restricted-properties -- installer integration tests intentionally exercise the host shell boundary */

import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  attemptInstall,
  createFixture,
  createInstallerWithSystemDirectory,
  removeFixtures,
  runInstaller,
  SYSTEM_PATH,
} from "./install-fixture.mjs";

afterEach(removeFixtures);

describe("release installer destination selection", () => {
  it("gives an explicit install directory precedence", async () => {
    const fixture = await createFixture();
    const localBin = join(fixture.home, ".local/bin");
    const explicit = join(fixture.root, "custom bin");
    await mkdir(localBin, { recursive: true });

    const result = runInstaller(fixture, {
      AURA_INSTALL_DIR: explicit,
      AURA_NO_MODIFY_PATH: "1",
      PATH: `${fixture.mockBin}:${localBin}:${SYSTEM_PATH}`,
    });

    expect(await readFile(join(explicit, "aura"), "utf8")).toContain("aura test binary");
    expect(result.stdout).toContain(`aura: installed to ${explicit}/aura`);
  });

  it("prefers a usable .local/bin already on PATH", async () => {
    const fixture = await createFixture();
    const localBin = join(fixture.home, ".local/bin");

    const result = runInstaller(fixture, {
      PATH: `${fixture.mockBin}:${localBin}:${SYSTEM_PATH}`,
    });

    expect(await readFile(join(localBin, "aura"), "utf8")).toContain("aura test binary");
    expect(result.stdout).toContain("aura: the install directory is already on PATH.");
  });

  it("uses HOME/bin when it is the first usable candidate", async () => {
    const fixture = await createFixture();
    const homeBin = join(fixture.home, "bin");

    const result = runInstaller(fixture, {
      PATH: `${fixture.mockBin}:${homeBin}:${SYSTEM_PATH}`,
    });

    expect(await readFile(join(homeBin, "aura"), "utf8")).toContain("aura test binary");
    expect(result.stdout).toContain(`aura: installed to ${homeBin}/aura`);
  });

  it("uses a writable system candidate when it is already on PATH", async () => {
    const fixture = await createFixture();
    const systemBin = join(fixture.root, "system-bin");
    await mkdir(systemBin);
    const installer = await createInstallerWithSystemDirectory(fixture, systemBin);

    const result = runInstaller(
      fixture,
      { PATH: `${fixture.mockBin}:${systemBin}:${SYSTEM_PATH}` },
      installer,
    );

    expect(await readFile(join(systemBin, "aura"), "utf8")).toContain("aura test binary");
    expect(result.stdout).toContain(`aura: installed to ${systemBin}/aura`);
  });

  it("rejects arbitrary writable PATH entries and falls back to .aura/bin", async () => {
    const fixture = await createFixture();
    const arbitraryBin = join(fixture.root, "arbitrary-bin");
    await mkdir(arbitraryBin);

    const result = runInstaller(fixture, {
      AURA_NO_MODIFY_PATH: "1",
      PATH: `${fixture.mockBin}:${arbitraryBin}:${SYSTEM_PATH}`,
    });
    const fallback = join(fixture.home, ".aura/bin");

    expect(await readFile(join(fallback, "aura"), "utf8")).toContain("aura test binary");
    expect(result.stdout).toContain(`aura: ${fallback} is not on your PATH.`);
  });
});

describe("release installer PATH configuration", () => {
  it("adds an idempotent zsh entry", async () => {
    const fixture = await createFixture();
    const profile = join(fixture.home, ".zshrc");

    const first = runInstaller(fixture);
    const second = runInstaller(fixture);
    const contents = await readFile(profile, "utf8");

    expect(first.stdout).toContain(`aura: added ${fixture.home}/.aura/bin to PATH in ${profile}.`);
    expect(second.stdout).toContain(`aura: PATH is already configured in ${profile}.`);
    expect(contents.match(/# Added by Aura installer/gu)).toHaveLength(1);
  });

  it("configures the platform-appropriate bash profile", async () => {
    const fixture = await createFixture();
    const profileName = process.platform === "darwin" ? ".bash_profile" : ".bashrc";
    const profile = join(fixture.home, profileName);

    runInstaller(fixture, { SHELL: "/bin/bash" });

    expect(await readFile(profile, "utf8")).toContain(
      `export PATH='${fixture.home}/.aura/bin':"$PATH"`,
    );
  });

  it("configures fish and creates its configuration directory", async () => {
    const fixture = await createFixture();
    const profile = join(fixture.home, ".config/fish/config.fish");

    runInstaller(fixture, { SHELL: "/usr/bin/fish" });

    expect(await readFile(profile, "utf8")).toContain(
      `set -gx PATH '${fixture.home}/.aura/bin' $PATH`,
    );
  });

  it("does not change a profile when modification is disabled", async () => {
    const fixture = await createFixture();
    const profile = join(fixture.home, ".zshrc");
    await writeFile(profile, "# existing configuration\n");

    const result = runInstaller(fixture, { AURA_NO_MODIFY_PATH: "1" });

    expect(await readFile(profile, "utf8")).toBe("# existing configuration\n");
    expect(result.stdout).toContain("Add this to");
  });

  it("prints instructions for an unknown shell", async () => {
    const fixture = await createFixture();

    const result = runInstaller(fixture, { SHELL: "/bin/unknown" });

    expect(result.stdout).toContain("Add this to your shell profile");
  });

  it("prints instructions when the selected profile is not writable", async () => {
    const fixture = await createFixture();
    const profile = join(fixture.home, ".zshrc");
    await writeFile(profile, "# existing configuration\n");
    await chmod(profile, 0o444);

    const result = runInstaller(fixture);

    expect(result.stdout).toContain(`Add this to ${profile}`);
    expect(await readFile(profile, "utf8")).toBe("# existing configuration\n");
  });

  it("quotes an explicit install path containing spaces", async () => {
    const fixture = await createFixture();
    const installDirectory = join(fixture.root, "Aura tools/bin");
    const profile = join(fixture.home, ".zshrc");

    runInstaller(fixture, { AURA_INSTALL_DIR: installDirectory });

    expect(await readFile(profile, "utf8")).toContain(`export PATH='${installDirectory}':"$PATH"`);
  });
});

describe("release installer input validation", () => {
  it("refuses a relative install directory", async () => {
    const fixture = await createFixture();

    const result = attemptInstall(fixture, { AURA_INSTALL_DIR: "relative/bin" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AURA_INSTALL_DIR must be an absolute path");
  });

  it("refuses a release tag that is not URL-safe", async () => {
    const fixture = await createFixture();

    const result = attemptInstall(fixture, { AURA_VERSION: "v1.0.0/../../etc" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid release tag");
  });

  it("treats a trailing slash on the install directory as the same directory", async () => {
    const fixture = await createFixture();
    const explicit = join(fixture.root, "explicit-bin");
    await mkdir(explicit);

    const result = runInstaller(fixture, {
      AURA_INSTALL_DIR: `${explicit}/`,
      PATH: `${fixture.mockBin}:${explicit}:${SYSTEM_PATH}`,
    });

    expect(result.stdout).toContain(`aura: installed to ${explicit}/aura`);
    expect(result.stdout).toContain("aura: the install directory is already on PATH.");
  });
});

describe("release installer binary placement", () => {
  it("replaces a binary that is currently executing", async () => {
    const fixture = await createFixture();
    const target = join(fixture.home, ".aura/bin");
    runInstaller(fixture, { AURA_NO_MODIFY_PATH: "1" });

    // Hold the installed binary open for the duration of the second install. Writing over the
    // file in place would fail with ETXTBSY here; renaming onto it does not.
    await writeFile(join(target, "aura"), "#!/bin/sh\nprintf ready\nsleep 30\n");
    await chmod(join(target, "aura"), 0o755);
    const running = spawn(join(target, "aura"), { stdio: ["ignore", "pipe", "ignore"] });

    try {
      await new Promise((resolve, reject) => {
        running.stdout.once("data", resolve);
        running.once("error", reject);
      });

      const second = runInstaller(fixture, { AURA_NO_MODIFY_PATH: "1" });

      expect(second.stdout).toContain(`aura: installed to ${target}/aura`);
      expect(await readFile(join(target, "aura"), "utf8")).toContain("aura test binary");
    } finally {
      running.kill("SIGKILL");
    }
  });

  it("leaves no staging file behind in the install directory", async () => {
    const fixture = await createFixture();
    const target = join(fixture.home, ".aura/bin");

    runInstaller(fixture, { AURA_NO_MODIFY_PATH: "1" });

    expect(await readdir(target)).toEqual(["aura"]);
  });
});

describe("release installer PATH snippet", () => {
  it("writes a guard so a nested shell does not re-prepend the directory", async () => {
    const fixture = await createFixture();
    const target = `${fixture.home}/.aura/bin`;
    const profile = join(fixture.home, ".zshrc");

    runInstaller(fixture);
    const snippet = await readFile(profile, "utf8");

    // Sourcing the profile twice must leave exactly one copy of the directory on PATH.
    const sourced = spawnSync("sh", ["-c", `. "${profile}"; . "${profile}"; printf '%s' "$PATH"`], {
      encoding: "utf8",
      env: { ...process.env, HOME: fixture.home, PATH: SYSTEM_PATH },
    });

    expect(snippet).toContain(`# Added by Aura installer (${target})`);
    expect(sourced.stdout.split(":").filter((entry) => entry === target)).toHaveLength(1);
  });
});
