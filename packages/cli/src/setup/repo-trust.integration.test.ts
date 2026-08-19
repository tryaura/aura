import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { definePlugin, type AuraManifest } from "@tryaura/aura-sdk";
import { createEnvironment, createPluginRegistry, hashRepoPreset } from "@tryaura/core";
import { afterEach, describe, expect, it } from "vitest";

import { BRANDING, findingPlugin, fixtureAdapter, noopTelemetry } from "../testing.js";
import { runSetup, type SetupRequest } from "./setup.js";
import { createScriptedWizardIo, type ScriptedWizardScript } from "./wizard-scripted.js";

const PRESET = JSON.stringify({ name: "Repo policy", schemaVersion: 1 });
const TRUST_PROMPT =
  "Trust the repository preset at .aura/preset.json? Its settings apply to every Aura run in this repository until the file changes.";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("repository preset trust across a setup run", () => {
  it("keeps the acceptance when the user backs out of the wizard a step later", async () => {
    const fixture = await createFixture();

    const exitCode = await runSetup(
      fixture.request({ confirmations: ["accepted"], forms: ["aborted"] }),
    );

    expect(exitCode).toBe(1);
    expect(await trustedPaths(fixture.homeDir)).toEqual([
      { hash: hashRepoPreset(PRESET), path: join(fixture.workspace, ".aura", "preset.json") },
    ]);
    expect(fixture.stdout()).toContain(
      "Recorded your trust of .aura/preset.json. Left everything else as it was.",
    );
    expect(fixture.stdout()).not.toContain("\nLeft everything as it was.");
  });

  it("does not ask again on the next run", async () => {
    const fixture = await createFixture();
    await runSetup(fixture.request({ confirmations: ["accepted"], forms: ["aborted"] }));

    const second = fixture.request({ forms: ["aborted"] });
    await runSetup(second);

    expect(second.io.notes.some((note) => note.includes("provides the preset"))).toBe(false);
  });

  it("keeps the acceptance when the user declines the plan at the confirmation", async () => {
    const fixture = await createFixture();

    const exitCode = await runSetup(
      fixture.request({ confirmations: ["accepted", "declined", "declined", "declined"] }),
    );

    expect(exitCode).toBe(0);
    expect(await trustedPaths(fixture.homeDir)).toHaveLength(1);
  });

  it("records nothing and says nothing was touched when the trust prompt is aborted", async () => {
    const fixture = await createFixture();

    const exitCode = await runSetup(fixture.request({ confirmations: ["aborted"] }));

    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toContain("Left everything as it was.");
    expect(fixture.stdout()).not.toContain("Recorded your trust");
    await expect(readFile(join(fixture.homeDir, "agents", "aura.json"), "utf8")).rejects.toThrow();
  });

  it("does not scan adapters when the trust prompt is aborted", async () => {
    const fixture = await createFixture();
    let adapterScans = 0;
    const registry = createPluginRegistry([
      findingPlugin("info", []),
      definePlugin({
        adapters: [
          fixtureAdapter(() => {
            adapterScans += 1;
            return { installed: false };
          }),
        ],
        apiVersion: 1,
        id: "scan-sentinel",
        name: "Scan sentinel",
        version: "1.0.0",
      }),
    ]);

    await runSetup({ ...fixture.request({ confirmations: ["aborted"] }), registry });

    expect(adapterScans).toBe(0);
  });

  it("records nothing when the trust prompt is declined, so the next run asks again", async () => {
    const fixture = await createFixture();
    await runSetup(fixture.request({ confirmations: ["declined"], forms: ["aborted"] }));

    const second = fixture.request({ confirmations: ["declined"], forms: ["aborted"] });
    await runSetup(second);

    expect(second.io.notes.some((note) => note.includes("provides the preset"))).toBe(true);
  });

  it("writes nothing on a dry run and says the next run will ask again", async () => {
    const fixture = await createFixture();

    const exitCode = await runSetup({
      ...fixture.request({ confirmations: ["accepted"] }),
      dryRun: true,
    });

    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toContain(
      "Dry run: the acceptance of .aura/preset.json was not recorded, so the next run asks again.",
    );
    expect(fixture.stdout()).toContain("Dry run: nothing was written.");
    await expect(readFile(join(fixture.homeDir, "agents", "aura.json"), "utf8")).rejects.toThrow();
  });

  it("records the acceptance once when the run goes on to apply its plan", async () => {
    const fixture = await createFixture();

    await runSetup(fixture.request({ confirmations: ["accepted"] }));

    expect(await trustedPaths(fixture.homeDir)).toHaveLength(1);
  });

  it("reports a recorded acceptance when the remaining plan is already converged", async () => {
    const fixture = await createFixture();

    const exitCode = await runSetup({
      ...fixture.request({ confirmations: ["accepted"] }),
      steps: [],
    });

    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toContain("Repository preset trust recorded before this plan:");
    expect(fixture.stdout()).toContain("Trust of .aura/preset.json is already saved");
    expect(fixture.stdout()).toContain(
      "Recorded your trust of .aura/preset.json. Left everything else as it was.",
    );
    expect(fixture.stdout()).not.toContain("Already converged — nothing to do.");
  });

  it("does not claim nothing changed when a later plan is blocked", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.homeDir, "agents", "AGENTS.md"));

    const exitCode = await runSetup(fixture.request({ confirmations: ["accepted"] }));

    expect(exitCode).toBe(2);
    expect(fixture.stderr()).toContain("the repository preset trust record was the only change");
    expect(fixture.stderr()).not.toContain("nothing was changed");
    expect(fixture.stdout()).toContain(
      "Recorded your trust of .aura/preset.json. Left everything else as it was.",
    );
  });

  it("applies a trust the primary checkout already recorded, without asking", async () => {
    const fixture = await createFixture({ worktree: true });
    await writeManifest(fixture.homeDir, [
      { hash: hashRepoPreset(PRESET), path: join(fixture.mainCheckout, ".aura", "preset.json") },
    ]);

    const request = fixture.request({ forms: ["aborted"] });
    await runSetup(request);

    expect(request.io.notes.some((note) => note.includes("provides the preset"))).toBe(false);
    expect(request.io.confirmPrompts).not.toContain(TRUST_PROMPT);
  });
});

interface Fixture {
  readonly homeDir: string;
  /** Primary checkout root; equal to the workspace unless the fixture built a worktree. */
  readonly mainCheckout: string;
  readonly request: (script: ScriptedWizardScript) => SetupRequest & {
    readonly io: { readonly confirmPrompts: readonly string[]; readonly notes: readonly string[] };
  };
  readonly stderr: () => string;
  readonly stdout: () => string;
  readonly workspace: string;
}

/**
 * A machine with one repository preset and nothing else to converge.
 * `worktree: true` puts the run inside a linked worktree of a primary checkout that carries the
 * same preset contents, which is the shape a parallel-worktree user actually runs in.
 */
async function createFixture(options: { readonly worktree?: boolean } = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aura-repo-trust-")));
  temporaryDirectories.push(root);
  const homeDir = join(root, "home");
  const mainCheckout = join(root, "main");
  const workspace = options.worktree === true ? join(root, "tree") : mainCheckout;
  await mkdir(join(homeDir, "agents"), { recursive: true });
  await mkdir(join(mainCheckout, ".git", "worktrees", "tree"), { recursive: true });
  await mkdir(join(mainCheckout, ".aura"), { recursive: true });
  await writeFile(join(mainCheckout, ".aura", "preset.json"), PRESET, "utf8");
  if (options.worktree === true) {
    await mkdir(join(workspace, ".aura"), { recursive: true });
    await writeFile(join(workspace, ".aura", "preset.json"), PRESET, "utf8");
    await writeFile(
      join(workspace, ".git"),
      `gitdir: ${join(mainCheckout, ".git", "worktrees", "tree")}\n`,
      "utf8",
    );
  }

  const environment = createEnvironment({ cwd: workspace, environmentVariables: {}, homeDir });
  const registry = createPluginRegistry([findingPlugin("info", [])]);
  let captured = "";
  let capturedStderr = "";

  return {
    homeDir,
    mainCheckout,
    request: (script) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      captured = "";
      capturedStderr = "";
      stdout.setEncoding("utf8");
      stderr.setEncoding("utf8");
      stdout.on("data", (chunk: string) => {
        captured += chunk;
      });
      stderr.on("data", (chunk: string) => {
        capturedStderr += chunk;
      });
      const scripted = createScriptedWizardIo({ ...script, output: stdout });
      const confirmPrompts: string[] = [];
      const io = {
        ask: scripted.ask,
        confirm: async (prompt: string, flow?: Parameters<typeof scripted.confirm>[1]) => {
          confirmPrompts.push(prompt);
          return scripted.confirm(prompt, flow);
        },
        confirmPrompts,
        load: scripted.load,
        note: scripted.note,
        notes: scripted.notes,
      };
      return {
        branding: BRANDING,
        colorDepth: 0,
        dryRun: false,
        environment,
        interactive: true,
        io,
        registry,
        stateHomeDir: homeDir,
        stderr,
        stdout,
        telemetry: noopTelemetry(),
        withDetail: false,
      };
    },
    stderr: () => capturedStderr,
    stdout: () => captured,
    workspace,
  };
}

async function writeManifest(
  homeDir: string,
  trustedRepoPresets: AuraManifest["trustedRepoPresets"],
): Promise<void> {
  const manifest = {
    apps: {},
    mcpServers: [],
    ownership: {},
    schemaVersion: 1,
    skills: [],
    snippets: [],
    trustedRepoPresets,
  };
  await writeFile(
    join(homeDir, "agents", "aura.json"),
    `${JSON.stringify(manifest, undefined, 2)}\n`,
    {
      mode: 0o600,
    },
  );
}

async function trustedPaths(homeDir: string): Promise<AuraManifest["trustedRepoPresets"]> {
  const manifest = JSON.parse(
    await readFile(join(homeDir, "agents", "aura.json"), "utf8"),
  ) as AuraManifest;
  return manifest.trustedRepoPresets;
}
