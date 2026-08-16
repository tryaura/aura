import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { createEnvironment, createPluginRegistry, type PluginRegistry } from "@tryaura/core";
import type { Environment } from "@tryaura/aura-sdk";

import { BRANDING, findingPlugin } from "../testing.js";
import { runSetup, type SetupRequest } from "./setup.js";
import { SETUP_ABORTED, type SetupStep } from "./types.js";
import { createScriptedWizardIo, type ScriptedWizardScript } from "./wizard-scripted.js";

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
    script?: ScriptedWizardScript,
    overrides?: Partial<SetupRequest>,
  ) => SetupRequest;
  readonly stderr: () => string;
  readonly stdout: () => string;
}

async function createFixture(seed?: (homeDir: string) => Promise<void>): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "aura-setup-run-"));
  temporaryDirectories.push(root);
  const homeDir = join(root, "home");
  const workspace = join(root, "workspace");
  await mkdir(homeDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await seed?.(homeDir);

  const environment = createEnvironment({ cwd: workspace, environmentVariables: {}, homeDir });
  // One always-passing check, so "end on green" has a checklist to be green about.
  const registry = createPluginRegistry([findingPlugin("info", [])], {});
  const stdout = capture();
  const stderr = capture();

  return {
    environment,
    homeDir,
    registry,
    request: (script = {}, overrides = {}) => ({
      branding: BRANDING,
      dryRun: false,
      environment,
      io: createScriptedWizardIo({ ...script, output: stdout.stream }),
      registry,
      stateHomeDir: homeDir,
      stderr: stderr.stream,
      stdout: stdout.stream,
      withDetail: false,
      ...overrides,
    }),
    stderr: () => stderr.read(),
    stdout: () => stdout.read(),
  };
}

describe("runSetup", () => {
  it("applies the baseline on a bare machine and ends on the green checklist", async () => {
    const fixture = await createFixture();

    const exitCode = await runSetup(fixture.request());

    expect(exitCode).toBe(0);
    await expect(readFile(join(fixture.homeDir, "agents", "aura.json"), "utf8")).resolves.toContain(
      '"schemaVersion": 1',
    );
    await expect(readFile(join(fixture.homeDir, "agents", "AGENTS.md"), "utf8")).resolves.toBe(
      "# Shared agent instructions\n",
    );
    const manifestMode = (await stat(join(fixture.homeDir, "agents", "aura.json"))).mode & 0o777;
    expect(manifestMode).toBe(0o600);
    expect(fixture.stdout()).toContain("Passed (1)");
    expect(fixture.stdout()).toContain("backup");
  });

  it("converges to a no-op on the second run without touching the journal", async () => {
    const fixture = await createFixture();
    await runSetup(fixture.request());
    const before = await snapshot(fixture.homeDir);

    const exitCode = await runSetup(fixture.request());

    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toContain("Already converged — nothing to change.");
    await expect(snapshot(fixture.homeDir)).resolves.toEqual(before);
  });

  it("leaves the filesystem untouched when the wizard is aborted at any step", async () => {
    const steps: readonly SetupStep[] = [stubStep("first"), stubStep("second")];

    for (let abortAt = 0; abortAt < steps.length; abortAt += 1) {
      const fixture = await createFixture();
      const before = await snapshot(fixture.homeDir);
      const forms = [...Array.from({ length: abortAt }, () => ({})), "aborted" as const];

      const exitCode = await runSetup(fixture.request({ forms }, { steps }));

      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toContain("Left everything as it was.");
      await expect(snapshot(fixture.homeDir)).resolves.toEqual(before);
    }
  });

  it("leaves the filesystem untouched when the confirmation is declined", async () => {
    const fixture = await createFixture();
    const before = await snapshot(fixture.homeDir);

    const exitCode = await runSetup(fixture.request({ confirmations: ["declined"] }));

    expect(exitCode).toBe(0);
    await expect(snapshot(fixture.homeDir)).resolves.toEqual(before);
  });

  it("exits 1 and writes nothing when the confirmation is aborted", async () => {
    const fixture = await createFixture();
    const before = await snapshot(fixture.homeDir);

    const exitCode = await runSetup(fixture.request({ confirmations: ["aborted"] }));

    expect(exitCode).toBe(1);
    await expect(snapshot(fixture.homeDir)).resolves.toEqual(before);
  });

  it("stops at the plan under --dry-run and writes nothing", async () => {
    const fixture = await createFixture();
    const before = await snapshot(fixture.homeDir);

    const exitCode = await runSetup(fixture.request({}, { dryRun: true }));

    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toContain("Dry run: nothing was written.");
    expect(fixture.stdout()).toContain("create");
    await expect(snapshot(fixture.homeDir)).resolves.toEqual(before);
  });

  it("refuses to run against an unreadable manifest before asking anything", async () => {
    const fixture = await createFixture(async (homeDir) => {
      await mkdir(join(homeDir, "agents"), { recursive: true });
      await writeFile(join(homeDir, "agents", "aura.json"), "{ not json", "utf8");
    });
    const before = await snapshot(fixture.homeDir);

    const exitCode = await runSetup(fixture.request({ forms: [{}] }));

    expect(exitCode).toBe(2);
    expect(fixture.stderr()).toContain("not valid JSON");
    await expect(snapshot(fixture.homeDir)).resolves.toEqual(before);
  });

  it("reports an unreadable shared-instructions path as a blocker and writes nothing", async () => {
    const fixture = await createFixture(async (homeDir) => {
      await mkdir(join(homeDir, "agents", "AGENTS.md"), { recursive: true });
      await writeFile(
        join(homeDir, "agents", "aura.json"),
        `${JSON.stringify({
          apps: {},
          mcpServers: [],
          ownership: {},
          schemaVersion: 1,
          skills: [],
          snippets: [],
        })}\n`,
        "utf8",
      );
    });
    const before = await snapshot(fixture.homeDir);

    const exitCode = await runSetup(fixture.request());

    expect(exitCode).toBe(2);
    expect(fixture.stdout()).toContain("cannot configure shared instructions");
    expect(fixture.stdout()).toContain("Blocked, and left out of the plan");
    expect(fixture.stdout()).toContain("unsupported");
    expect(fixture.stdout()).not.toContain("already in place");
    expect(fixture.stdout()).not.toContain("Already converged");
    expect(fixture.stderr()).toContain("the plan is blocked");
    await expect(snapshot(fixture.homeDir)).resolves.toEqual(before);
  });
});

function stubStep(id: string): SetupStep {
  return {
    gather: async (context, io) => {
      const result = await io.ask([
        {
          id,
          initial: ["go"],
          kind: "select",
          label: id,
          options: [{ label: "Go", value: "go" }],
          prompt: `Continue past ${id}?`,
        },
      ]);
      return result === "aborted" ? SETUP_ABORTED : context.selections;
    },
    id,
    title: id,
  };
}

function capture(): { readonly read: () => string; readonly stream: PassThrough } {
  const stream = new PassThrough();
  stream.setEncoding("utf8");
  const chunks: string[] = [];
  stream.on("data", (chunk: string) => {
    chunks.push(chunk);
  });
  return { read: () => chunks.join(""), stream };
}

/** Every path under `directory` with its file contents, as one comparable record. */
async function snapshot(directory: string): Promise<Readonly<Record<string, string>>> {
  const entries: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        entries[`${relative(directory, path)}/`] = "directory";
        await walk(path);
      } else {
        entries[relative(directory, path)] = await readFile(path, "utf8");
      }
    }
  };
  await walk(directory);
  return entries;
}
