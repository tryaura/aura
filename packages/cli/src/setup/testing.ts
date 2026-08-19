import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";

import { createEnvironment, createPluginRegistry } from "@tryaura/core";

import { BRANDING, noopTelemetry } from "../testing.js";
import type { McpSetupCatalog } from "./mcp-catalog.js";
import type { SetupRequest } from "./setup.js";
import type { SkillCatalog } from "./skills-catalog.js";
import { createSnippetCatalog, type SnippetCatalog } from "./snippets.js";
import { createScriptedWizardIo } from "./wizard-scripted.js";
import type { WizardAnswers } from "./wizard-types.js";

export interface Fixture {
  readonly homeDir: string;
  /** Everything the most recent {@link request} wrote to stdout. */
  readonly output: () => string;
  readonly request: (
    registry: ReturnType<typeof createPluginRegistry>,
    forms?: readonly WizardAnswers[],
  ) => SetupRequest;
  readonly workspace: string;
}

const temporaryDirectories: string[] = [];

/** Removes every directory {@link createFixture} made; call from `afterEach`. */
export async function cleanupFixtures(): Promise<void> {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
}

/**
 * A throwaway directory registered with {@link cleanupFixtures}.
 *
 * Lives here rather than in each test-support module because this file is the package's one
 * sanctioned reader of ambient OS state; everything else goes through the injected `Environment`.
 */
export async function createTemporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

/** The real catalog over an empty registry, for a context whose test never reaches a snippet. */
export function emptySnippetCatalog(): SnippetCatalog {
  return createSnippetCatalog([], {
    exists: false,
    path: "/home/dev/agents/aura.json",
    status: "missing",
  });
}

/** An empty picker input, for a context whose test never reaches the MCP step. */
export function emptyMcpCatalog(): McpSetupCatalog {
  return { entries: [], missingRequiredIds: [], requiredIds: new Set() };
}

/** A catalog with no sources and no policy, for a context whose test never reaches skills. */
export function emptySkillCatalog(): SkillCatalog {
  return {
    load: () => Promise.resolve({ entries: [], notes: [], unavailableSources: [] }),
    pendingSources: () => [],
    policy: { presetName: ".aura/preset.json" },
    privateSources: [],
    resolve: () => Promise.resolve({ problems: new Map(), resolved: new Map() }),
  };
}

export async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "aura-instruction-setup-"));
  temporaryDirectories.push(root);
  const homeDir = join(root, "home");
  const workspace = join(root, "workspace");
  await mkdir(homeDir);
  await mkdir(workspace);
  const environment = createEnvironment({
    cwd: workspace,
    environmentVariables: {},
    homeDir,
    // Hermetic: no fixture-driven setup run may reach the network.
    httpGet: () => Promise.resolve({ kind: "failure", reason: "network" }),
  });

  let captured = "";

  return {
    homeDir,
    output: () => captured,
    request: (registry, forms) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      captured = "";
      stdout.setEncoding("utf8");
      stdout.on("data", (chunk: string) => {
        captured += chunk;
      });
      return {
        branding: BRANDING,
        colorDepth: 0,
        dryRun: false,
        environment,
        interactive: false,
        io: createScriptedWizardIo({ ...(forms === undefined ? {} : { forms }), output: stdout }),
        registry,
        stateHomeDir: homeDir,
        stderr,
        stdout,
        telemetry: noopTelemetry(),
        withDetail: false,
      };
    },
    workspace,
  };
}

export async function backupEntry(homeDir: string): Promise<string> {
  const root = join(homeDir, "agents", ".backups");
  const name = (await readdir(root)).find((entry) => /^\d/u.test(entry));
  if (name === undefined) {
    throw new Error("Expected a setup backup entry.");
  }
  return join(root, name);
}

/** Every file below `directory`, by relative path, so a re-run can be compared to what preceded it. */
export async function snapshot(directory: string): Promise<Readonly<Record<string, string>>> {
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
