import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

import { defineAdapter, definePlugin, type DriverSkillPack } from "@tryaura/aura-sdk";
import { createEnvironment, createPluginRegistry } from "@tryaura/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BRANDING, findingPlugin, noopTelemetry } from "../testing.js";
import { runSetup, type SetupRequest } from "./setup.js";
import { skillIdentity } from "./skill-planner-paths.js";
import { skillsStep } from "./steps/skills.js";
import { createScriptedWizardIo } from "./wizard-scripted.js";

const roots: string[] = [];
const SOURCE_ID = "driver:fixture/registry";
const IDENTITY = skillIdentity(SOURCE_ID, "review");
const SKILL_MD = "---\nname: review\n---\n\nReview a change.\n";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("driver skill setup flow", () => {
  it("reviews, installs, and records a driver skill without repeating work after back", async () => {
    const fixture = await createFixture({ interactive: true });

    const exitCode = await runSetup(
      fixture.request({
        forms: [
          { skills: { kind: "options", values: [IDENTITY] } },
          { [`review:${IDENTITY}`]: { kind: "options", values: ["install"] } },
          { [`review:${IDENTITY}`]: { kind: "options", values: ["install"] } },
        ],
        confirmations: ["back", "accepted"],
      }),
    );

    expect(exitCode, fixture.output()).toBe(0);
    expect(fixture.list).toHaveBeenCalledTimes(1);
    expect(fixture.resolve).toHaveBeenCalledTimes(1);
    expect(fixture.resolve.mock.calls[0]?.[1]).toEqual(["review"]);
    await expect(
      readFile(join(fixture.homeDir, "agents", "skills", "review", "SKILL.md"), "utf8"),
    ).resolves.toBe(SKILL_MD);
    const manifest = JSON.parse(
      await readFile(join(fixture.homeDir, "agents", "aura.json"), "utf8"),
    );
    expect(manifest.skills).toEqual([
      expect.objectContaining({ id: "review", source: SOURCE_ID, version: "1.0.0" }),
    ]);
  });

  it("keeps driver methods offline in non-interactive setup", async () => {
    const fixture = await createFixture({ interactive: false });

    const exitCode = await runSetup(fixture.request({ forms: [] }));

    expect(exitCode).toBe(0);
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.resolve).not.toHaveBeenCalled();
  });

  it("names the plugin that disabled a driver instead of dropping it silently", async () => {
    const fixture = await createFixture({ disabled: true, interactive: true });

    const exitCode = await runSetup(fixture.request({ forms: [] }));

    expect(exitCode).toBe(0);
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.output()).toContain(`Skill source "${SOURCE_ID}" is not offered`);
    expect(fixture.output()).toContain('plugin "policy"');
  });

  it("preserves an existing selection when driver resolution fails", async () => {
    const fixture = await createFixture({ failResolve: true, interactive: true, previous: true });

    const exitCode = await runSetup(
      fixture.request({
        forms: [{ skills: { kind: "options", values: [IDENTITY] } }],
      }),
    );

    expect(exitCode).toBe(0);
    expect(fixture.output()).not.toContain("secret resolution failure");
    await expect(
      readFile(join(fixture.homeDir, "agents", "skills", "review", "SKILL.md"), "utf8"),
    ).resolves.toBe(SKILL_MD);
    await expect(readFile(join(fixture.homeDir, "agents", "aura.json"), "utf8")).resolves.toContain(
      SOURCE_ID,
    );
  });
});

async function createFixture(options: {
  readonly disabled?: boolean;
  readonly failResolve?: boolean;
  readonly interactive: boolean;
  readonly previous?: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), "aura-driver-flow-"));
  roots.push(root);
  const homeDir = join(root, "home");
  const workspace = join(root, "workspace");
  const sourceRoot = join(root, "source-skill");
  await mkdir(join(homeDir, "agents"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(sourceRoot, "SKILL.md"), SKILL_MD);
  if (options.previous === true) {
    await mkdir(join(homeDir, "agents", "skills", "review"), { recursive: true });
    await writeFile(join(homeDir, "agents", "skills", "review", "SKILL.md"), SKILL_MD);
  }
  await writeFile(
    join(homeDir, "agents", "aura.json"),
    `${JSON.stringify(
      {
        apps: { fixture: { managed: true } },
        mcpServers: [],
        ownership: {},
        schemaVersion: 1,
        skills:
          options.previous === true
            ? [
                {
                  id: "review",
                  pinned: false,
                  source: SOURCE_ID,
                  treeHash: skillTreeHash(SKILL_MD),
                  version: "1.0.0",
                },
              ]
            : [],
        snippets: [],
      },
      undefined,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  const listing = {
    description: "Reviews a change.",
    id: "review",
    name: "Review",
    originUrl: "https://skills.example.com/review",
    version: "1.0.0",
  } as const;
  const pack: DriverSkillPack = {
    ...listing,
    kind: "skill-pack",
    source: { type: "directory", url: pathToFileURL(sourceRoot).href },
  };
  const list = vi.fn().mockResolvedValue([listing]);
  const resolve =
    options.failResolve === true
      ? vi.fn().mockRejectedValue(new Error("secret resolution failure"))
      : vi.fn().mockResolvedValue(new Map([["review", pack]]));
  const registry = createPluginRegistry([
    findingPlugin("info", []),
    definePlugin({
      adapters: [
        defineAdapter({
          capabilities: {
            skills: { directories: [{ entryPath: "~/.fixture/skills", id: "skills" }] },
          },
          detect: () => Promise.resolve({ installed: false }),
          displayName: "Fixture App",
          files: () => [],
          id: "fixture",
          parse: () => ({ instructionFiles: [], mcpServers: [], skills: [] }),
          supportedRange: ">=1",
        }),
      ],
      apiVersion: 2,
      id: "fixture",
      name: "Fixture",
      skillSources: [
        {
          description: "Fixture skills.",
          id: "fixture/registry",
          list,
          name: "Fixture registry",
          resolve,
        },
      ],
      version: "1.0.0",
    }),
    ...(options.disabled === true
      ? [
          definePlugin({
            apiVersion: 2,
            disabledSkillSources: [SOURCE_ID],
            id: "policy",
            name: "Policy",
            version: "1.0.0",
          }),
        ]
      : []),
  ]);
  const output = new PassThrough();
  output.setEncoding("utf8");
  let captured = "";
  output.on("data", (chunk: string) => {
    captured += chunk;
  });

  return {
    homeDir,
    list,
    output: () => captured,
    request: (script: Parameters<typeof createScriptedWizardIo>[0]): SetupRequest => ({
      branding: BRANDING,
      colorDepth: 0,
      dryRun: false,
      environment: createEnvironment({ cwd: workspace, homeDir }),
      interactive: options.interactive,
      io: createScriptedWizardIo({ ...script, output }),
      registry,
      stateHomeDir: homeDir,
      stderr: output,
      stdout: output,
      steps: [skillsStep],
      telemetry: noopTelemetry(),
      withDetail: false,
    }),
    resolve,
  };
}

function skillTreeHash(content: string): string {
  const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
  return createHash("sha256").update(`f:SKILL.md:${contentHash}\n`, "utf8").digest("hex");
}
