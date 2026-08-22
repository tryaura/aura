/* eslint-disable no-restricted-properties -- installer integration tests intentionally exercise the host shell boundary */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  attemptInstall,
  createFixture,
  removeFixtures,
  runInstaller,
  SYSTEM_PATH,
} from "./install-fixture.mjs";

afterEach(removeFixtures);

describe("release installer security boundaries", () => {
  it("refuses to replace an executable in an automatically selected directory", async () => {
    const fixture = await createFixture();
    const localBin = join(fixture.home, ".local/bin");
    const existing = join(localBin, "aura");
    await mkdir(localBin, { recursive: true });
    await writeFile(existing, "package-managed aura\n");

    const result = attemptInstall(fixture, {
      PATH: `${fixture.mockBin}:${localBin}:${SYSTEM_PATH}`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing to replace existing");
    expect(await readFile(existing, "utf8")).toBe("package-managed aura\n");
  });

  it("refuses an install directory containing a PATH separator", async () => {
    const fixture = await createFixture();

    const result = attemptInstall(fixture, {
      AURA_INSTALL_DIR: `${fixture.root}/unsafe:directory`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not contain ':'");
  });

  it("refuses an install directory containing a line break", async () => {
    const fixture = await createFixture();

    const result = attemptInstall(fixture, {
      AURA_INSTALL_DIR: `${fixture.root}/unsafe\ntouch injected`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not contain line breaks");
    expect(await readdir(fixture.home)).not.toContain(".zshrc");
  });

  it.skipIf(process.platform !== "darwin")(
    "preserves an existing Bash login profile on macOS",
    async () => {
      const fixture = await createFixture();
      const profile = join(fixture.home, ".profile");
      await writeFile(profile, "# existing login configuration\n");

      runInstaller(fixture, { SHELL: "/bin/bash" });

      expect(await readFile(profile, "utf8")).toContain("# existing login configuration");
      expect(await readFile(profile, "utf8")).toContain("# Added by Aura installer");
      expect(await readdir(fixture.home)).not.toContain(".bash_profile");
    },
  );
});
