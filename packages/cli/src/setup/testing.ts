import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";

import { createEnvironment, createPluginRegistry } from "@tryaura/core";
import {
  defineAdapter,
  defineCheck,
  definePlugin,
  SHARED_INSTRUCTIONS_TEMPLATE_TOKEN,
  type AdapterFileSpec,
  type AuraPlugin,
} from "@tryaura/aura-sdk";

import { BRANDING, noopTelemetry } from "../testing.js";
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
 * Asks for archival wherever the question comes up.
 *
 * Spelled out because the question defaults to keeping originals: a question's initial answer is
 * what `--yes` accepts, and removing files the user wrote by hand is not something a
 * non-interactive run should choose on its own.
 *
 * Repeated once per form the flow may open, since the scripted io consumes one entry per `ask` and
 * ignores ids that question did not pose — which keeps this independent of step ordering.
 */
export function archiveOriginals(): readonly WizardAnswers[] {
  const answer: WizardAnswers = {
    "global-archive-originals": { kind: "options", values: ["archive"] },
    "project-archive-originals": { kind: "options", values: ["archive"] },
  };
  return Array.from({ length: 8 }, () => answer);
}

/** The real catalog over an empty registry, for a context whose test never reaches a snippet. */
export function emptySnippetCatalog(): SnippetCatalog {
  return createSnippetCatalog([], {
    exists: false,
    path: "/home/dev/agents/aura.json",
    status: "missing",
  });
}

/** A catalog with no sources and no policy, for a context whose test never reaches skills. */
export function emptySkillCatalog(): SkillCatalog {
  return {
    load: () => Promise.resolve({ entries: [], notes: [], unavailableSources: [] }),
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

export function consolidationPlugin(): AuraPlugin {
  const ids = ["instructions.claude", "instructions.cursor", "instructions.windsurf"];
  const adapter = defineAdapter({
    detect: () => Promise.resolve({ installed: true, version: "1.0.0" }),
    displayName: "Fixture Agent",
    files: ({ environment }) => [
      instructionSpec(ids[0] ?? "claude", join(environment.homeDir, ".claude", "CLAUDE.md")),
      instructionSpec(ids[1] ?? "cursor", join(environment.homeDir, ".cursorrules")),
      instructionSpec(ids[2] ?? "windsurf", join(environment.homeDir, ".windsurfrules")),
    ],
    id: "fixture-agent",
    parse: ({ files }) => ({
      instructionFiles: [...files.values()].flatMap((file) =>
        file.content === undefined
          ? []
          : [
              {
                content: file.content,
                links: [],
                path: file.spec.path,
                scope: file.spec.scope,
                sourceId: file.spec.id,
              },
            ],
      ),
      mcpServers: [],
      skills: [],
    }),
    sharedLink: {
      entryPath: "~/.claude/CLAUDE.md",
      kind: "import-line",
      lineTemplate: `@${SHARED_INSTRUCTIONS_TEMPLATE_TOKEN}`,
    },
    supportedRange: ">=1 <2",
  });
  const duplicates = defineCheck({
    defaultSeverity: "warn",
    detect: (model) => {
      const claude = model.instructionFiles.find((document) => document.sourceId === ids[0]);
      const cursor = model.instructionFiles.find((document) => document.sourceId === ids[1]);
      if (claude === undefined || cursor === undefined) {
        return [];
      }
      // Byte-identical files cluster whole-file, the way the real INS-003 reports them; otherwise
      // the fixture reports the one shared line its tests place at line 3 of both files.
      const wholeFile = claude.content === cursor.content;
      const lastLine = wholeFile ? claude.content.split(/\r?\n/u).length : 3;
      return [
        {
          id: "fixture-duplicate",
          message: "Duplicate fixture guidance.",
          metadata: {
            identical: true,
            matches: [{ kind: "exact", left: 0, right: 1, similarity: 100 }],
            members: [
              { endLine: lastLine, path: claude.path, startLine: wholeFile ? 1 : 3 },
              { endLine: lastLine, path: cursor.path, startLine: wholeFile ? 1 : 3 },
            ],
          },
        },
      ];
    },
    explain: "Fixture duplicate check.",
    fixability: "manual",
    id: "INS-003",
    scope: "global",
    title: "Fixture instructions are unique",
  });
  return definePlugin({
    adapters: [adapter],
    apiVersion: 1,
    checks: [duplicates],
    id: "checks-core",
    name: "Fixture Checks",
    version: "1.0.0",
  });
}

function instructionSpec(id: string, path: string): AdapterFileSpec {
  return { id, kind: "instructions", optional: true, path, scope: "global" };
}

export function projectConsolidationPlugin(): AuraPlugin {
  return definePlugin({
    adapters: [
      defineAdapter({
        detect: () => Promise.resolve({ installed: true, version: "1.0.0" }),
        displayName: "Project Claude",
        files: ({ environment }) => [
          {
            id: "project-claude",
            kind: "instructions",
            optional: true,
            path: join(environment.cwd, "CLAUDE.md"),
            scope: "project",
          },
        ],
        id: "project-claude",
        parse: ({ files }) => {
          const file = files.get("project-claude");
          return {
            instructionFiles:
              file?.content === undefined
                ? []
                : [
                    {
                      content: file.content,
                      links: [],
                      path: file.spec.path,
                      scope: file.spec.scope,
                      sourceId: file.spec.id,
                    },
                  ],
            mcpServers: [],
            skills: [],
          };
        },
        projectSharedLink: {
          entryPath: "./CLAUDE.md",
          kind: "import-line",
          lineTemplate: `@${SHARED_INSTRUCTIONS_TEMPLATE_TOKEN}`,
        },
        supportedRange: ">=1 <2",
      }),
    ],
    apiVersion: 1,
    id: "project-consolidation",
    name: "Project Consolidation",
    version: "1.0.0",
  });
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
