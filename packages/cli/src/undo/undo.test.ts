import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { createEnvironment, createPluginRegistry, type PluginRegistry } from "@tryaura/core";
import type { Environment } from "@tryaura/aura-sdk";

import { runSetup } from "../setup/setup.js";
import { backupEntry } from "../setup/testing.js";
import { createScriptedWizardIo, type ScriptedWizardScript } from "../setup/wizard-scripted.js";
import { BRANDING, capturingTelemetry, findingPlugin, noopTelemetry } from "../testing.js";
import { runUndo, type UndoRequest } from "./undo.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

interface Fixture {
  readonly environment: Environment;
  readonly homeDir: string;
  readonly registry: PluginRegistry;
  readonly request: (
    overrides?: Partial<UndoRequest>,
    script?: ScriptedWizardScript,
  ) => UndoRequest;
  /** Runs one defaults-accepting setup, so a backup entry exists to restore. */
  readonly setup: () => Promise<void>;
  readonly stderr: () => string;
  readonly stdout: () => string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "aura-undo-run-"));
  temporaryDirectories.push(root);
  const homeDir = join(root, "home");
  const workspace = join(root, "workspace");
  await mkdir(homeDir, { recursive: true });
  await mkdir(workspace, { recursive: true });

  const environment = createEnvironment({ cwd: workspace, environmentVariables: {}, homeDir });
  const registry = createPluginRegistry([findingPlugin("info", [])], {});
  const stdout = capture();
  const stderr = capture();

  return {
    environment,
    homeDir,
    registry,
    request: (overrides = {}, script = {}) => ({
      branding: BRANDING,
      dryRun: false,
      environment,
      io: createScriptedWizardIo({ ...script, output: stdout.stream }),
      list: false,
      registry,
      stateHomeDir: homeDir,
      stderr: stderr.stream,
      stdout: stdout.stream,
      telemetry: noopTelemetry(),
      yes: false,
      ...overrides,
    }),
    setup: async () => {
      const exitCode = await runSetup({
        branding: BRANDING,
        colorDepth: 0,
        dryRun: false,
        environment,
        io: createScriptedWizardIo({ output: stdout.stream }),
        registry,
        stateHomeDir: homeDir,
        stderr: stderr.stream,
        stdout: stdout.stream,
        telemetry: noopTelemetry(),
        withDetail: false,
      });
      expect(exitCode).toBe(0);
    },
    stderr: () => stderr.read(),
    stdout: () => stdout.read(),
  };
}

describe("runUndo", () => {
  it("says there is nothing to list before any run has staged a backup", async () => {
    const fixture = await createFixture();

    const exitCode = await runUndo(fixture.request({ list: true }));

    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toContain("No backups.");
  });

  it("says there is nothing to undo before any run has staged a backup", async () => {
    const fixture = await createFixture();

    const exitCode = await runUndo(fixture.request());

    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toContain("Nothing to undo.");
  });

  it("lists a setup backup as restorable", async () => {
    const fixture = await createFixture();
    await fixture.setup();
    const id = basename(await backupEntry(fixture.homeDir));

    const exitCode = await runUndo(fixture.request({ list: true }));

    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toContain(id);
    expect(fixture.stdout()).toContain("applied");
    expect(fixture.stdout()).toContain("Run acme undo [<id>] to restore one.");
  });

  it("restores the newest backup after one confirmation", async () => {
    const fixture = await createFixture();
    await fixture.setup();
    const manifest = join(fixture.homeDir, "agents", "aura.json");
    await expect(access(manifest)).resolves.toBeUndefined();

    const exitCode = await runUndo(fixture.request());

    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toContain("Restored backup");
    await expect(access(manifest)).rejects.toThrow();
    await expect(access(join(fixture.homeDir, "agents", "AGENTS.md"))).rejects.toThrow();
  });

  it("finds nothing to undo once the only backup is undone", async () => {
    const fixture = await createFixture();
    await fixture.setup();
    await runUndo(fixture.request({ yes: true }));

    const exitCode = await runUndo(fixture.request());

    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toContain("Nothing to undo.");
  });

  it("restores a backup named on the command line", async () => {
    const fixture = await createFixture();
    await fixture.setup();
    const id = basename(await backupEntry(fixture.homeDir));

    const exitCode = await runUndo(fixture.request({ backupId: id, yes: true }));

    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toContain(`Restored backup ${id}`);
  });

  it("refuses an unknown backup name", async () => {
    const fixture = await createFixture();
    await fixture.setup();

    const exitCode = await runUndo(
      fixture.request({ backupId: "2020-01-01T00-00-00-000Z", yes: true }),
    );

    expect(exitCode).toBe(2);
    expect(fixture.stderr()).toContain("no backup named 2020-01-01T00-00-00-000Z");
  });

  it("names the reason when the requested backup cannot be read", async () => {
    const fixture = await createFixture();
    await fixture.setup();
    const entry = await backupEntry(fixture.homeDir);
    const id = basename(entry);
    await writeFile(join(entry, "manifest.json"), "{broken\n", "utf8");

    const exitCode = await runUndo(fixture.request({ backupId: id, yes: true }));

    expect(exitCode).toBe(2);
    expect(fixture.stderr()).toContain(`backup ${id} cannot be read`);
  });

  it("refuses a backup that is already undone", async () => {
    const fixture = await createFixture();
    await fixture.setup();
    const id = basename(await backupEntry(fixture.homeDir));
    await runUndo(fixture.request({ yes: true }));

    const exitCode = await runUndo(fixture.request({ backupId: id, yes: true }));

    expect(exitCode).toBe(2);
    expect(fixture.stderr()).toContain(`backup ${id} is already undone`);
  });

  it("names the entry and writes nothing under --dry-run", async () => {
    const fixture = await createFixture();
    await fixture.setup();
    const manifest = join(fixture.homeDir, "agents", "aura.json");

    const exitCode = await runUndo(fixture.request({ dryRun: true }));

    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toContain("Would restore backup");
    expect(fixture.stdout()).toContain("Nothing was written.");
    await expect(access(manifest)).resolves.toBeUndefined();
  });

  it("leaves everything as it was when the prompt is declined or aborted", async () => {
    const fixture = await createFixture();
    await fixture.setup();
    const manifest = join(fixture.homeDir, "agents", "aura.json");

    // Declining and aborting both abandon the restore, and the documented contract folds them
    // into one exit code: 1, aborted or declined at the prompt.
    const declined = await runUndo(fixture.request({}, { confirmations: ["declined"] }));
    expect(declined).toBe(1);

    const aborted = await runUndo(fixture.request({}, { confirmations: ["aborted"] }));
    expect(aborted).toBe(1);

    expect(fixture.stdout()).toContain("Left everything as it was.");
    await expect(access(manifest)).resolves.toBeUndefined();
  });

  it("emits one undo-run event naming how the run ended", async () => {
    const fixture = await createFixture();

    const listed = capturingTelemetry();
    await runUndo(fixture.request({ list: true, telemetry: listed.telemetry }));
    expect(listed.events).toEqual([
      expect.objectContaining({
        command: "undo",
        exitCode: 0,
        kind: "undo-run",
        outcome: "listed",
      }),
    ]);

    const nothing = capturingTelemetry();
    await runUndo(fixture.request({ telemetry: nothing.telemetry, yes: true }));
    expect(nothing.events).toEqual([
      expect.objectContaining({ exitCode: 0, outcome: "nothing-to-undo" }),
    ]);

    await fixture.setup();

    const refused = capturingTelemetry();
    await runUndo(fixture.request({ backupId: "no-such-backup", telemetry: refused.telemetry }));
    expect(refused.events).toEqual([expect.objectContaining({ exitCode: 2, outcome: "refused" })]);

    const declined = capturingTelemetry();
    await runUndo(
      fixture.request({ telemetry: declined.telemetry }, { confirmations: ["declined"] }),
    );
    expect(declined.events).toEqual([
      expect.objectContaining({ exitCode: 1, outcome: "declined" }),
    ]);

    const restored = capturingTelemetry();
    await runUndo(fixture.request({ telemetry: restored.telemetry, yes: true }));
    expect(restored.events).toEqual([
      expect.objectContaining({
        exitCode: 0,
        outcome: "restored",
        restoredOperationCount: expect.any(Number),
        skippedBackupCount: 0,
      }),
    ]);
  });
});

function capture(): { readonly read: () => string; readonly stream: PassThrough } {
  const stream = new PassThrough();
  stream.setEncoding("utf8");
  const chunks: string[] = [];
  stream.on("data", (chunk: string) => {
    chunks.push(chunk);
  });
  return { read: () => chunks.join(""), stream };
}
