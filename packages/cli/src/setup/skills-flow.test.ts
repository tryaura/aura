import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { createEnvironment, createPluginRegistry, hashRepoPreset } from "@tryaura/core";
import { defineAdapter, definePlugin } from "@tryaura/aura-sdk";

import { BRANDING, findingPlugin, noopTelemetry } from "../testing.js";
import { runSetup, type SetupRequest } from "./setup.js";
import { skillIdentity } from "./skill-planner-paths.js";
import { skillsStep } from "./steps/skills.js";
import { createScriptedWizardIo, type ScriptedWizardScript } from "./wizard-scripted.js";

const TOKEN = "sk-fixture-secret";
const SKILL_MD = "---\nname: review\n---\n\nReview changes before landing.\n";
const IDENTITY = skillIdentity("directory:acme", "review");

const LISTING = {
  description: "Review changes before landing.",
  id: "review",
  name: "Review",
  version: "1.0.0",
};

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

interface MockDirectory {
  readonly requests: readonly {
    readonly authorization: string | undefined;
    readonly path: string;
  }[];
  readonly url: string;
}

/** A minimal standard-protocol directory; the testkit's mock is off limits below the CLI. */
async function startMockDirectory(): Promise<MockDirectory> {
  const requests: { authorization: string | undefined; path: string }[] = [];
  const server = createServer((request, response) => {
    requests.push({ authorization: request.headers.authorization, path: request.url ?? "" });
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401);
      response.end("unauthorized");
      return;
    }
    if (request.url === "/index.json") {
      response.end(JSON.stringify([LISTING]));
      return;
    }
    if (request.url === "/skills/review") {
      response.end(
        JSON.stringify({ ...LISTING, files: [{ content: SKILL_MD, path: "SKILL.md" }] }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return { requests, url: `http://127.0.0.1:${String(address.port)}` };
}

interface Fixture {
  readonly homeDir: string;
  readonly request: (script: ScriptedWizardScript) => SetupRequest;
  readonly stdout: () => string;
}

async function createFixture(directoryUrl: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "aura-skills-flow-"));
  temporaryDirectories.push(root);
  const homeDir = join(root, "home");
  const workspace = join(root, "workspace");
  await mkdir(join(homeDir, "agents"), { recursive: true });
  await mkdir(join(workspace, ".aura"), { recursive: true });
  const preset = JSON.stringify({
    allowedSkillSources: ["directory:acme"],
    schemaVersion: 1,
    skillDirectories: [
      {
        id: "directory:acme",
        name: "Acme Skills",
        tokenEnv: "ACME_SKILLS_TOKEN",
        url: directoryUrl,
      },
    ],
  });
  await writeFile(
    join(homeDir, "agents", "aura.json"),
    `${JSON.stringify(
      {
        apps: { fixture: { managed: true } },
        mcpServers: [],
        ownership: {},
        schemaVersion: 1,
        skills: [],
        snippets: [],
        // The repository preset is pre-trusted: this suite covers the install flow, and the
        // first-use trust prompt is interactive-only while these runs answer for the user.
        trustedRepoPresets: [
          { hash: hashRepoPreset(preset), path: join(workspace, ".aura", "preset.json") },
        ],
      },
      undefined,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await writeFile(join(workspace, ".aura", "preset.json"), preset);

  const environment = createEnvironment({
    cwd: workspace,
    environmentVariables: { ACME_SKILLS_TOKEN: TOKEN },
    homeDir,
  });
  // One always-passing check, so "end on green" has a checklist to be green about.
  const registry = createPluginRegistry(
    [
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
        apiVersion: 1,
        id: "fixture-app",
        name: "Fixture App",
        version: "1.0.0",
      }),
    ],
    {},
  );
  const output = new PassThrough();
  output.setEncoding("utf8");
  let captured = "";
  output.on("data", (chunk: string) => {
    captured += chunk;
  });

  return {
    homeDir,
    request: (script) => ({
      branding: BRANDING,
      colorDepth: 0,
      dryRun: false,
      environment,
      interactive: false,
      io: createScriptedWizardIo({ ...script, output }),
      registry,
      stateHomeDir: homeDir,
      stderr: output,
      stdout: output,
      steps: [skillsStep],
      telemetry: noopTelemetry(),
      withDetail: false,
    }),
    stdout: () => captured,
  };
}

/** Every file below `root`, path → contents. */
async function allFiles(root: string): Promise<Readonly<Record<string, string>>> {
  const contents: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        contents[path] = await readFile(path, "utf8");
      }
    }
  };
  await walk(root);
  return contents;
}

describe("skills directory install flow", () => {
  it("fails closed before networking when the team preset is invalid", async () => {
    const mock = await startMockDirectory();
    const fixture = await createFixture(mock.url);
    const workspace = fixture.request({ forms: [] }).environment.cwd;
    await writeFile(join(workspace, ".aura", "preset.json"), "{ broken", "utf8");

    const exitCode = await runSetup(fixture.request({ forms: [] }));

    expect(exitCode).toBe(2);
    expect(mock.requests).toEqual([]);
    expect(fixture.stdout()).toContain("is not valid JSON");
  });

  it("installs a reviewed skill and never persists the token anywhere", async () => {
    const mock = await startMockDirectory();
    const fixture = await createFixture(mock.url);

    const exitCode = await runSetup(
      fixture.request({
        forms: [
          {
            "approved-private-sources": {
              kind: "options",
              values: ["directory:acme"],
            },
          },
          { skills: { kind: "options", values: [IDENTITY] } },
          { [`review:${IDENTITY}`]: { kind: "options", values: ["install"] } },
        ],
      }),
    );

    expect(exitCode, fixture.stdout()).toBe(0);
    await expect(
      readFile(join(fixture.homeDir, "agents", "skills", "review", "SKILL.md"), "utf8"),
    ).resolves.toBe(SKILL_MD);
    const manifest = await readFile(join(fixture.homeDir, "agents", "aura.json"), "utf8");
    expect(manifest).toContain('"directory:acme"');
    expect(manifest).toContain('"version": "1.0.0"');

    // The token reached the directory as a bearer header and nothing else, anywhere.
    expect(mock.requests.length).toBeGreaterThanOrEqual(2);
    for (const request of mock.requests) {
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
    }
    const files = await allFiles(fixture.homeDir);
    for (const [path, content] of Object.entries(files)) {
      expect(content, path).not.toContain(TOKEN);
    }
    expect(fixture.stdout()).not.toContain(TOKEN);
  });

  it("installs nothing when the review is left at its Skip default", async () => {
    const mock = await startMockDirectory();
    const fixture = await createFixture(mock.url);

    const exitCode = await runSetup(
      fixture.request({
        // The picker checks the skill; the exhausted script leaves the review on Skip.
        forms: [
          {
            "approved-private-sources": {
              kind: "options",
              values: ["directory:acme"],
            },
          },
          { skills: { kind: "options", values: [IDENTITY] } },
        ],
      }),
    );

    expect(exitCode, fixture.stdout()).toBe(0);
    const files = await allFiles(fixture.homeDir);
    expect(Object.keys(files).some((path) => path.includes("agents/skills"))).toBe(false);
    const manifest = await readFile(join(fixture.homeDir, "agents", "aura.json"), "utf8");
    expect(manifest).not.toContain("directory:acme");
  });
});
