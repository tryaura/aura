/* eslint-disable no-restricted-imports, no-restricted-properties -- installer integration tests intentionally exercise the host shell boundary */

/**
 * Fixtures for the release installer tests: a throwaway HOME, a stubbed `curl` that serves a
 * locally built release, and helpers to run the real script against them.
 */

import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { expect } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const INSTALLER = join(ROOT, "apps/web/public/install");
export const SYSTEM_PATH = "/usr/bin:/bin";

const TARGET = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;

const temporaryDirectories = [];

export async function removeFixtures() {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
}

export async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "aura-install-test-"));
  temporaryDirectories.push(root);

  const home = join(root, "home");
  const mockBin = join(root, "mock-bin");
  const release = join(root, "release");
  const archiveRoot = join(root, "archive");
  const archiveName = `aura-${TARGET}.tar.gz`;
  const archive = join(release, archiveName);

  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(mockBin, { recursive: true }),
    mkdir(release, { recursive: true }),
    mkdir(archiveRoot, { recursive: true }),
  ]);

  await writeFile(join(archiveRoot, "aura"), "#!/bin/sh\nprintf 'aura test binary\\n'\n");
  await chmod(join(archiveRoot, "aura"), 0o755);

  const archiveResult = spawnSync("tar", ["-czf", archive, "-C", archiveRoot, "aura"], {
    encoding: "utf8",
  });
  expect(archiveResult.status, archiveResult.stderr).toBe(0);

  const digest = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await writeFile(join(release, "SHA256SUMS"), `${digest}  ${archiveName}\n`);

  // The installer calls curl with long-form flags; anything it does not name is skipped so a new
  // hardening flag does not silently become the request URL.
  const curl = join(mockBin, "curl");
  await writeFile(
    curl,
    `#!/bin/sh
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o | --output)
      output="$2"
      shift 2
      ;;
    --write-out | --connect-timeout | --retry | --proto | --proto-redir)
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
case "$url" in
  */SHA256SUMS) cp "$AURA_TEST_RELEASE/SHA256SUMS" "$output" ;;
  *) cp "$AURA_TEST_RELEASE/${archiveName}" "$output" ;;
esac
`,
  );
  await chmod(curl, 0o755);

  return { home, mockBin, release, root };
}

export function attemptInstall(fixture, overrides = {}, installer = INSTALLER) {
  return spawnSync("sh", [installer], {
    // Anchored away from the repository: a regression that resolves a relative install directory
    // must not be able to write into the working tree.
    cwd: fixture.root,
    encoding: "utf8",
    // Built from nothing rather than from process.env: the installer reads HOME, SHELL, ZDOTDIR,
    // XDG_CONFIG_HOME and the AURA_* switches, so an inherited value (GitHub's Linux runners export
    // XDG_CONFIG_HOME) would send profile writes outside the fixture and fail only on that host.
    env: {
      AURA_TEST_RELEASE: fixture.release,
      AURA_VERSION: "v0.0.0-test",
      HOME: fixture.home,
      PATH: `${fixture.mockBin}:${SYSTEM_PATH}`,
      SHELL: "/bin/zsh",
      ...overrides,
    },
  });
}

export function runInstaller(fixture, overrides = {}, installer = INSTALLER) {
  const result = attemptInstall(fixture, overrides, installer);

  expect(result.status, result.stderr).toBe(0);
  return result;
}

/** The system candidate is a real absolute path, so exercising it needs a rewritten copy. */
export async function createInstallerWithSystemDirectory(fixture, systemDirectory) {
  const installer = join(fixture.root, "install");
  const source = await readFile(INSTALLER, "utf8");
  await writeFile(installer, source.replaceAll("/usr/local/bin", systemDirectory));
  return installer;
}
