/* eslint-disable max-lines -- one end-to-end setup matrix shares the same filesystem fixtures. */
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createEnvironment, createPluginRegistry, type PluginRegistry } from "@tryaura/core";
import { definePlugin, type Adapter, type Environment } from "@tryaura/aura-sdk";
import claudeCodePlugin from "@tryaura/adapter-claude-code";
import codexPlugin from "@tryaura/adapter-codex";

import {
  appsPlugin,
  BRANDING,
  capturingTelemetry,
  findingPlugin,
  noopTelemetry,
} from "../testing.js";
import { runSetup, type SetupRequest } from "./setup.js";
import { projectConsolidationPlugin } from "./testing-plugins.js";
import { SETUP_ABORTED, SETUP_BACK, type SetupStep } from "./types.js";
import { createScriptedWizardIo, type ScriptedWizardScript } from "./wizard-scripted.js";
import type { WizardFlowContext, WizardIo } from "./wizard-types.js";

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
      colorDepth: 0,
      dryRun: false,
      environment,
      interactive: false,
      io: createScriptedWizardIo({ ...script, output: stdout.stream }),
      registry,
      stateHomeDir: homeDir,
      stderr: stderr.stream,
      stdout: stdout.stream,
      telemetry: noopTelemetry(),
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
    expect(fixture.stdout()).toContain("Already converged — nothing to do.");
    await expect(snapshot(fixture.homeDir)).resolves.toEqual(before);
  });

  it("installs a bundled skill into Claude Code and Codex and converges twice", async () => {
    const fixture = await createFixture();
    const pack = join(fixture.homeDir, "fixture-pack");
    await mkdir(join(pack, "references"), { recursive: true });
    await writeFile(join(pack, "SKILL.md"), "---\nname: review\n---\n# Review\n", "utf8");
    await writeFile(join(pack, "references", "guide.md"), "Guide\n", "utf8");
    const installedClaude = {
      ...firstAdapter(claudeCodePlugin.adapters),
      detect: () => Promise.resolve({ installed: true }),
    };
    const installedCodex = {
      ...firstAdapter(codexPlugin.adapters),
      detect: () => Promise.resolve({ installed: true }),
    };
    const registry = createPluginRegistry([
      findingPlugin("info", []),
      definePlugin({
        adapters: [installedClaude, installedCodex],
        apiVersion: 1,
        id: "fixture-skills",
        name: "Fixture Skills",
        skills: [
          {
            description: "Review code.",
            id: "review",
            kind: "skill-pack",
            name: "Review",
            source: { type: "directory", url: pathToFileURL(pack).href },
            version: "1.0.0",
          },
        ],
        version: "1.0.0",
      }),
    ]);
    const step: SetupStep = {
      gather: (context) =>
        Promise.resolve({
          ...context.selections,
          apps: { managed: ["claude-code", "codex"] },
          skills: { selected: [{ id: "review", source: "plugin:fixture-skills" }] },
        }),
      id: "fixture-skills",
      title: "fixture skills",
    };

    const firstExit = await runSetup(fixture.request({}, { registry, steps: [step] }));
    expect(firstExit, `${fixture.stdout()}\n${fixture.stderr()}`).toBe(0);
    const manifest = JSON.parse(
      await readFile(join(fixture.homeDir, "agents", "aura.json"), "utf8"),
    );
    expect(manifest.skills).toEqual([
      {
        id: "review",
        pinned: false,
        source: "plugin:fixture-skills",
        treeHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        version: "1.0.0",
      },
    ]);
    const sharedSkill = join(await realpath(fixture.homeDir), "agents", "skills", "review");
    await expect(readlink(join(fixture.homeDir, ".claude", "skills", "review"))).resolves.toBe(
      sharedSkill,
    );
    await expect(readlink(join(fixture.homeDir, ".codex", "skills", "review"))).resolves.toBe(
      sharedSkill,
    );

    const before = await snapshot(fixture.homeDir);
    expect(await runSetup(fixture.request({}, { registry, steps: [step] }))).toBe(0);
    expect(fixture.stdout()).toContain("Already converged — nothing to do.");
    await expect(snapshot(fixture.homeDir)).resolves.toEqual(before);
  });

  it("onboards an explicit bundled preset and converges with its exact sticky reference", async () => {
    const fixture = await createFixture();
    const content = join(fixture.homeDir, "preset-plugin");
    const skill = join(content, "skills", "review");
    await mkdir(skill, { recursive: true });
    await writeFile(join(content, "rules.md"), "Use reviewed changes.\n", "utf8");
    await writeFile(
      join(content, "mcp.json"),
      JSON.stringify({
        credentialEnv: [],
        description: "Fixture documentation.",
        docsUrl: "https://example.test/docs",
        id: "fixture/docs",
        name: "Fixture docs",
        schemaVersion: 1,
        serverName: "fixture-docs",
        supportedApps: ["codex"],
        transportTemplate: { command: "fixture-docs-mcp", type: "stdio" },
      }),
      "utf8",
    );
    await writeFile(
      join(content, "preset.json"),
      JSON.stringify({
        checks: { severity: { "fixture-info/INFO": "warn" } },
        name: "Fixture onboarding",
        requiredMcpServers: ["fixture/docs"],
        schemaVersion: 1,
        skills: [{ id: "review", source: "plugin:fixture" }],
        snippets: ["fixture/rules"],
      }),
      "utf8",
    );
    await writeFile(join(skill, "SKILL.md"), "---\nname: review\n---\n# Review\n", "utf8");
    const installedCodex = {
      ...firstAdapter(codexPlugin.adapters),
      detect: () => Promise.resolve({ installed: true, version: "0.147.0" }),
    };
    const registry = createPluginRegistry([
      findingPlugin("info", []),
      definePlugin({
        adapters: [installedCodex],
        apiVersion: 1,
        id: "fixture",
        mcpCatalog: [
          {
            description: "Fixture documentation.",
            id: "fixture/docs",
            kind: "mcp-server",
            name: "Fixture docs",
            source: { type: "file", url: pathToFileURL(join(content, "mcp.json")).href },
            version: "1.0.0",
          },
        ],
        name: "Fixture onboarding",
        presets: [
          {
            description: "Fixture onboarding preset.",
            id: "fixture/onboarding",
            kind: "preset",
            name: "Fixture onboarding",
            source: { type: "file", url: pathToFileURL(join(content, "preset.json")).href },
            version: "1.0.0",
          },
        ],
        skills: [
          {
            description: "Review changes.",
            id: "review",
            kind: "skill-pack",
            name: "Review",
            source: { type: "directory", url: pathToFileURL(skill).href },
            version: "1.0.0",
          },
        ],
        snippets: [
          {
            category: "workflow",
            description: "Use reviewed changes.",
            id: "fixture/rules",
            kind: "snippet",
            name: "Fixture rules",
            source: { type: "file", url: pathToFileURL(join(content, "rules.md")).href },
            version: "1.0.0",
          },
        ],
        version: "1.0.0",
      }),
    ]);

    const firstExit = await runSetup(
      fixture.request(
        {},
        {
          cliReference: "plugin:fixture/onboarding",
          interactive: true,
          registry,
        },
      ),
    );

    expect(firstExit, `${fixture.stdout()}\n${fixture.stderr()}`).toBe(0);
    const manifestPath = join(fixture.homeDir, "agents", "aura.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest).toMatchObject({
      apps: { codex: { managed: true } },
      mcpServers: [{ catalogId: "fixture/docs", name: "fixture-docs" }],
      preset: "plugin:fixture/onboarding",
      skills: [{ id: "review", source: "plugin:fixture", version: "1.0.0" }],
      snippets: [{ id: "fixture/rules", version: "1.0.0" }],
    });
    expect(manifest.checks).toBeUndefined();
    expect(fixture.stdout()).toContain(
      "Effective check policy from preset Fixture onboarding (not copied into your manifest):",
    );
    expect(fixture.stdout()).toContain("fixture-info/INFO: severity warn");

    const before = await snapshot(fixture.homeDir);
    const secondExit = await runSetup(fixture.request({}, { interactive: true, registry }));
    expect(secondExit).toBe(0);
    expect(fixture.stdout()).toContain("Nothing to change.");
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

  it("threads each step's flow position into the forms it opens", async () => {
    const fixture = await createFixture();
    const steps: readonly SetupStep[] = [stubStep("first"), stubStep("second")];
    const flows: (WizardFlowContext | undefined)[] = [];
    const base = createScriptedWizardIo();
    const io: WizardIo = {
      ...base,
      ask: async (questions, flow) => {
        flows.push(flow);
        return base.ask(questions, flow);
      },
    };

    await runSetup(fixture.request({}, { io, steps }));

    expect(flows).toEqual([
      { completed: [], step: { label: "first" }, upcoming: [{ label: "second" }] },
      { completed: [{ label: "first" }], step: { label: "second" }, upcoming: [] },
    ]);
  });

  it("re-runs the previous step when a form backs out, keeping its selections", async () => {
    const fixture = await createFixture();
    const steps: readonly SetupStep[] = [stubStep("first"), stubStep("second")];
    const asked: string[] = [];
    const base = createScriptedWizardIo({
      forms: [{}, "back", {}, {}],
    });
    const io: WizardIo = {
      ...base,
      ask: async (questions, flow) => {
        asked.push(questions[0]?.id ?? "?");
        return base.ask(questions, flow);
      },
    };

    const exitCode = await runSetup(fixture.request({}, { io, steps }));

    // first → second backs out → first again → second, then the run continues normally.
    expect(asked).toEqual(["first", "second", "first", "second"]);
    expect(exitCode).toBe(0);
  });

  it("tells a step it was entered backward and revisited so it can resume quietly", async () => {
    const fixture = await createFixture();
    const entries: {
      readonly backward: boolean;
      readonly id: string;
      readonly revisited: boolean;
    }[] = [];
    const record = (id: string): SetupStep => {
      const stub = stubStep(id);
      return {
        ...stub,
        gather: async (context, io) => {
          entries.push({
            backward: context.enteredBackward === true,
            id,
            revisited: context.revisited === true,
          });
          return stub.gather(context, io);
        },
      };
    };
    const steps = [record("first"), record("second")];

    await runSetup(fixture.request({ forms: [{}, "back", {}, {}] }, { steps }));

    expect(entries).toEqual([
      { backward: false, id: "first", revisited: false },
      { backward: false, id: "second", revisited: false },
      { backward: true, id: "first", revisited: true },
      { backward: false, id: "second", revisited: true },
    ]);
  });

  it("offers the project opt-out last, so --yes still configures rather than declining", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.environment.cwd, "CLAUDE.md"), "# Project\n\nRules.\n", "utf8");
    const registry = createPluginRegistry(
      [projectConsolidationPlugin(), findingPlugin("info", [])],
      {},
    );
    let options: readonly { readonly value: string }[] = [];
    const base = createScriptedWizardIo({});
    const io: WizardIo = {
      ...base,
      ask: async (questions, flow) => {
        const action = questions.find((question) => question.id === "project-instruction-action");
        if (action?.kind === "select") {
          options = action.options;
        }
        return base.ask(questions, flow);
      },
    };

    await expect(runSetup(fixture.request({}, { io, registry }))).resolves.toBe(0);

    // An empty script is the `--yes` path, and it takes each question's first option: the opt-out
    // must therefore sit last, or every non-interactive run would silently decline the scope.
    expect(options.map((option) => option.value)).toEqual(["consolidate", "template", "skip"]);
    await expect(readFile(join(fixture.environment.cwd, "AGENTS.md"), "utf8")).resolves.toContain(
      "# Instructions from CLAUDE.md",
    );
  });

  it("returns to the last step when the final confirmation backs out", async () => {
    const fixture = await createFixture();
    const asked: string[] = [];
    const base = createScriptedWizardIo({ confirmations: ["back", "accepted"] });
    const io: WizardIo = {
      ...base,
      ask: async (questions, flow) => {
        asked.push(questions[0]?.id ?? "?");
        return base.ask(questions, flow);
      },
    };

    const exitCode = await runSetup(fixture.request({}, { io }));

    // Only the last step re-runs before the plan is rebuilt and confirmed again.
    expect(asked.filter((id) => id === "baseline")).toHaveLength(2);
    expect(asked.filter((id) => id === "global-instruction-action")).toHaveLength(1);
    expect(exitCode).toBe(0);
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
    // The baseline note speaks only for the manifest, which really is in place; nothing in the
    // output may claim the shared instructions Aura just refused to read are settled.
    expect(fixture.stdout()).toContain("The Aura manifest is already in place.");
    expect(fixture.stdout()).not.toContain("Already converged");
    expect(fixture.stderr()).toContain("the plan is blocked");
    await expect(snapshot(fixture.homeDir)).resolves.toEqual(before);
  });
  it("stores the app selection in the manifest and lists install instructions", async () => {
    const fixture = await createFixture();
    const registry = createPluginRegistry([findingPlugin("info", []), appsPlugin()], {});

    const exitCode = await runSetup(
      fixture.request(
        { forms: [{ apps: { kind: "options", values: ["installed-app", "missing-app"] } }] },
        { registry },
      ),
    );

    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toContain("✓ Installed App 1.2.3");
    expect(fixture.stdout()).toContain("✗ Missing App — looked for the missing-app CLI on PATH");
    expect(fixture.stdout()).toContain("Steps to take yourself:");
    expect(fixture.stdout()).toContain("Install Missing App: brew install missing-app");
    const manifest = await readFile(join(fixture.homeDir, "agents", "aura.json"), "utf8");
    expect(JSON.parse(manifest)).toMatchObject({
      apps: {
        "installed-app": { managed: true },
        "missing-app": { managed: true },
      },
    });
    await expect(runSetup(fixture.request({}, { registry }))).resolves.toBe(0);
    expect(fixture.stdout().match(/Steps to take yourself:/gu)).toHaveLength(2);
    expect(fixture.stdout()).not.toContain("Already converged — nothing to do.");
  });

  it("confirms an empty app selection before the plan confirmation", async () => {
    const fixture = await createFixture();
    const registry = createPluginRegistry([findingPlugin("info", []), appsPlugin()], {});
    const before = await snapshot(fixture.homeDir);

    // First confirmation: "nothing will be managed"; second: "Apply this plan?".
    const exitCode = await runSetup(
      fixture.request(
        {
          confirmations: ["accepted", "declined"],
          forms: [{ apps: { kind: "options", values: [] } }],
        },
        { registry },
      ),
    );

    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toContain("Left everything as it was.");
    await expect(snapshot(fixture.homeDir)).resolves.toEqual(before);
  });

  it("emits one applied setup-run event, then one converged event on the re-run", async () => {
    const fixture = await createFixture();
    const applied = capturingTelemetry();

    await runSetup(fixture.request({}, { telemetry: applied.telemetry }));

    expect(applied.events).toHaveLength(1);
    expect(applied.events[0]).toMatchObject({
      command: "setup",
      exitCode: 0,
      kind: "setup-run",
      manifest: { managedAppIds: [], mcpServers: { catalogIds: [], customCount: 0 } },
      outcome: "applied",
    });
    expect(applied.events[0]).toHaveProperty("appliedOperationCount");

    const converged = capturingTelemetry();
    await runSetup(fixture.request({}, { telemetry: converged.telemetry }));
    expect(converged.events).toHaveLength(1);
    expect(converged.events[0]).toMatchObject({ exitCode: 0, outcome: "converged" });
  });

  it("emits distinct outcomes for dry-run, declined, and aborted runs", async () => {
    const fixture = await createFixture();

    const dryRun = capturingTelemetry();
    await runSetup(fixture.request({}, { dryRun: true, telemetry: dryRun.telemetry }));
    expect(dryRun.events).toEqual([expect.objectContaining({ exitCode: 0, outcome: "dry-run" })]);

    const declined = capturingTelemetry();
    await runSetup(
      fixture.request({ confirmations: ["declined"] }, { telemetry: declined.telemetry }),
    );
    expect(declined.events).toEqual([
      expect.objectContaining({ exitCode: 0, outcome: "declined" }),
    ]);

    const aborted = capturingTelemetry();
    await runSetup(
      fixture.request({ confirmations: ["aborted"] }, { telemetry: aborted.telemetry }),
    );
    expect(aborted.events).toEqual([expect.objectContaining({ exitCode: 1, outcome: "aborted" })]);
  });

  it("emits an unusable setup-run event when the manifest cannot be used", async () => {
    const fixture = await createFixture(async (homeDir) => {
      await mkdir(join(homeDir, "agents"), { recursive: true });
      await writeFile(join(homeDir, "agents", "aura.json"), "{ not json", "utf8");
    });
    const { events, telemetry } = capturingTelemetry();

    await runSetup(fixture.request({ forms: [{}] }, { telemetry }));

    expect(events).toEqual([expect.objectContaining({ exitCode: 2, outcome: "unusable" })]);
    expect(events[0]).not.toHaveProperty("manifest");
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
      if (result === "aborted") {
        return SETUP_ABORTED;
      }
      if (result === "back") {
        return SETUP_BACK;
      }
      return context.selections;
    },
    id,
    title: id,
  };
}

function firstAdapter(adapters: readonly Adapter[] | undefined): Adapter {
  const adapter = adapters?.[0];
  if (adapter === undefined) {
    throw new Error("expected an adapter fixture");
  }
  return adapter;
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
      if (entry.isSymbolicLink()) {
        entries[relative(directory, path)] = `symlink:${await readlink(path)}`;
      } else if (entry.isDirectory()) {
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
