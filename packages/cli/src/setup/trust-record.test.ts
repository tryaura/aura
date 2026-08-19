import { mkdir, mkdtemp, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AuraManifest,
  AuraManifestState,
  Environment,
  WorkspaceModel,
} from "@tryaura/aura-sdk";
import {
  buildWorkspaceModel,
  createEmptyAuraManifest,
  createEnvironment,
  createFileReader,
  readAuraManifest,
  resolveAuraManifestPath,
  serializeAuraManifest,
  type WorkspaceScan,
} from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { recordRepoPresetTrust } from "./trust-record.js";

const HASH = "a".repeat(64);
const PRESET_PATH = "/repo/.aura/preset.json";
/** The timestamped directory name the journal gives one applied plan. */
const JOURNAL_ENTRY = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d{4})?$/u;

describe("recordRepoPresetTrust", () => {
  it("creates the manifest with the acceptance, held at the protocol mode", async () => {
    const fixture = await workspace();

    const outcome = await recordRepoPresetTrust({
      environment: fixture.environment,
      hash: HASH,
      mainWorktreePath: undefined,
      model: fixture.scan.model,
      path: PRESET_PATH,
      stateHomeDir: fixture.homeDir,
    });

    expect(outcome.manifest?.status).toBe("ready");
    const written = JSON.parse(await readFile(fixture.manifestPath, "utf8")) as AuraManifest;
    expect(written.trustedRepoPresets).toEqual([{ hash: HASH, path: PRESET_PATH }]);
    expect((await stat(fixture.manifestPath)).mode & 0o777).toBe(0o600);
  });

  it("records the repository identity when the run is inside a linked worktree", async () => {
    const fixture = await workspace();

    await recordRepoPresetTrust({
      environment: fixture.environment,
      hash: HASH,
      mainWorktreePath: "/main/.aura/preset.json",
      model: fixture.scan.model,
      path: PRESET_PATH,
      stateHomeDir: fixture.homeDir,
    });

    const written = JSON.parse(await readFile(fixture.manifestPath, "utf8")) as AuraManifest;
    expect(written.trustedRepoPresets).toEqual([
      { hash: HASH, mainWorktreePath: "/main/.aura/preset.json", path: PRESET_PATH },
    ]);
  });

  it("returns the state a later read would produce rather than the value it wrote", async () => {
    const fixture = await workspace();

    const outcome = await recordRepoPresetTrust({
      environment: fixture.environment,
      hash: HASH,
      mainWorktreePath: undefined,
      model: fixture.scan.model,
      path: PRESET_PATH,
      stateHomeDir: fixture.homeDir,
    });

    const reread = readAuraManifest(
      fixture.manifestPath,
      await createFileReader().read(fixture.manifestPath),
    );
    expect(outcome.manifest).toEqual(reread);
  });

  it("keeps everything the manifest already held", async () => {
    const existing: AuraManifest = {
      ...createEmptyAuraManifest(),
      ignoredApps: ["cursor"],
      preset: "acme@1.0.0",
    };
    const fixture = await workspace(existing);

    await recordRepoPresetTrust({
      environment: fixture.environment,
      hash: HASH,
      mainWorktreePath: undefined,
      model: fixture.scan.model,
      path: PRESET_PATH,
      stateHomeDir: fixture.homeDir,
    });

    const written = JSON.parse(await readFile(fixture.manifestPath, "utf8")) as AuraManifest;
    expect(written.preset).toBe("acme@1.0.0");
    expect(written.ignoredApps).toEqual(["cursor"]);
    expect(written.trustedRepoPresets).toHaveLength(1);
  });

  it("makes exactly one undo entry, and none at all for an acceptance already on disk", async () => {
    const fixture = await workspace();
    const options = {
      environment: fixture.environment,
      hash: HASH,
      mainWorktreePath: undefined,
      model: fixture.scan.model,
      path: PRESET_PATH,
      stateHomeDir: fixture.homeDir,
    };

    await recordRepoPresetTrust(options);
    expect(await backupCount(fixture.homeDir)).toBe(1);

    // The second call re-reads nothing: the model still carries the pre-write state, so this is
    // the same plan again, and the kernel must recognize the bytes it already wrote.
    await recordRepoPresetTrust(options);
    expect(await backupCount(fixture.homeDir)).toBe(1);
  });

  it("reports a blocked plan instead of throwing, so the run keeps the consent it has", async () => {
    const fixture = await workspace();
    // A manifest outside every writable root: the kernel refuses the operation, and refusing to
    // persist consent must not be the thing that ends a run the user is in the middle of.
    const stranger = await realpath(await mkdtemp(join(tmpdir(), "aura-trust-outside-")));
    const elsewhere: AuraManifestState = {
      exists: false,
      path: join(stranger, "aura.json"),
      status: "missing",
    };
    const outside: WorkspaceModel = { ...fixture.scan.model, manifest: elsewhere };

    const outcome = await recordRepoPresetTrust({
      environment: fixture.environment,
      hash: HASH,
      mainWorktreePath: undefined,
      model: outside,
      path: PRESET_PATH,
      stateHomeDir: fixture.homeDir,
    });

    expect(outcome.manifest).toBeUndefined();
    expect(outcome.problem).toBeTruthy();
  });
});

interface Fixture {
  readonly environment: Environment;
  readonly homeDir: string;
  readonly manifestPath: string;
  readonly root: string;
  readonly scan: WorkspaceScan;
}

async function workspace(manifest?: AuraManifest): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aura-trust-record-")));
  const homeDir = join(root, "home");
  const manifestPath = resolveAuraManifestPath(homeDir);
  await mkdir(join(homeDir, "agents"), { recursive: true });
  if (manifest !== undefined) {
    await writeFile(manifestPath, serializeAuraManifest(manifest, manifestPath), "utf8");
  }
  const environment = createEnvironment({ cwd: root, homeDir });
  const scan = await buildWorkspaceModel({ adapters: [], environment });
  return { environment, homeDir, manifestPath, root, scan };
}

/** Journal entries under the backup root, ignoring the lock and index files that sit beside them. */
async function backupCount(homeDir: string): Promise<number> {
  const entries = await readdir(join(homeDir, "agents", ".backups"));
  return entries.filter((entry) => JOURNAL_ENTRY.test(entry)).length;
}
