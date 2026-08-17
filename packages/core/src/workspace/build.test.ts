/* eslint-disable max-lines -- one workspace-builder matrix shares the same memory reader fixtures. */
import type {
  AdapterFileSpec,
  AdapterParseInput,
  InstalledSkill,
  McpServer,
} from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { buildWorkspaceModel, type WorkspaceScan, type WorkspaceScanOptions } from "../index.js";
import {
  createDocument,
  createLink,
  createMemoryReader,
  createSnapshot,
  createTestAdapter,
  createTestEnvironment,
  DIRECTORY,
} from "./testing.js";

const INSTRUCTIONS: AdapterFileSpec = {
  id: "instructions",
  kind: "instructions",
  path: "/home/dev/CLAUDE.md",
  scope: "global",
};

const SKILLS: AdapterFileSpec = {
  id: "skills",
  kind: "skills",
  path: "/home/dev/.claude/skills",
  scope: "global",
};

const SERVER: McpServer = {
  appId: "alpha",
  name: "sentry",
  scope: "global",
  sourceId: "instructions",
  transport: { type: "http", url: "https://mcp.sentry.dev" },
};

const SKILL: InstalledSkill = {
  appId: "alpha",
  id: "alpha/review",
  name: "Review",
  path: "/home/dev/.claude/skills/review",
  scope: "global",
};

describe("buildWorkspaceModel", () => {
  it("aggregates every application's contributions in adapter order", async () => {
    const alpha = createTestAdapter({
      files: () => [INSTRUCTIONS, SKILLS],
      id: "alpha",
      installHint: "Update Alpha with its installer.",
      parse: () =>
        createSnapshot({
          instructionFiles: [createDocument("/home/dev/CLAUDE.md")],
          mcpServers: [SERVER],
          skills: [SKILL],
        }),
    });
    const beta = createTestAdapter({
      id: "beta",
      parse: () =>
        createSnapshot({
          instructionFiles: [createDocument("/home/dev/AGENTS.md")],
          skills: [{ ...SKILL, appId: "beta", id: "beta/review" }],
        }),
    });

    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [alpha, beta],
      environment: createTestEnvironment({ cwd: "/workspace", homeDir: "/home/dev" }),
      reader: createMemoryReader({
        "/home/dev/.claude/skills": DIRECTORY,
        "/home/dev/CLAUDE.md": "# instructions",
      }),
    });

    expect(diagnostics).toEqual([]);
    expect(model.apps.map((app) => app.adapterId)).toEqual(["alpha", "beta"]);
    expect(model.apps[0]?.installHint).toBe("Update Alpha with its installer.");
    expect(model.instructionFiles.map((document) => document.path)).toEqual([
      "/home/dev/CLAUDE.md",
      "/home/dev/AGENTS.md",
    ]);
    expect(model.mcpServers).toEqual([SERVER]);
    expect(model.skills.map((skill) => skill.id)).toEqual(["alpha/review", "beta/review"]);
    expect(model.cwd).toBe("/workspace");
    expect(model.homeDir).toBe("/home/dev");
  });

  it("records which declared paths were found without retaining their contents", async () => {
    const adapter = createTestAdapter({ files: () => [INSTRUCTIONS, SKILLS] });

    const { model } = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createTestEnvironment(),
      reader: createMemoryReader({
        "/home/dev/.claude/skills": DIRECTORY,
        "/home/dev/CLAUDE.md": "# instructions",
      }),
    });

    expect(model.apps[0]?.sourceFiles).toStrictEqual([
      { exists: true, pathKind: "file", problem: undefined, spec: INSTRUCTIONS },
      { exists: true, pathKind: "directory", problem: undefined, spec: SKILLS },
    ]);
  });

  it("hands parse spec-keyed files, resolution context, and directory listings", async () => {
    let received: AdapterParseInput | undefined;
    const adapter = createTestAdapter({
      files: () => [SKILLS, INSTRUCTIONS],
      parse: (input) => {
        received = input;
        return createSnapshot();
      },
    });

    await buildWorkspaceModel({
      adapters: [adapter],
      environment: createTestEnvironment(),
      reader: createMemoryReader({
        "/home/dev/.claude/skills": DIRECTORY,
        "/home/dev/.claude/skills/review": DIRECTORY,
        "/home/dev/.claude/skills/summarize": DIRECTORY,
        "/home/dev/CLAUDE.md": "# instructions",
      }),
    });

    expect(received?.detection).toEqual({ installed: true, version: "1.0.0" });
    expect(received?.cwd).toBe("/workspace");
    expect(received?.homeDir).toBe("/home/dev");
    expect(received?.projectRoot).toBeUndefined();
    expect(received?.files).toStrictEqual(
      new Map([
        [
          "skills",
          {
            entries: ["review", "summarize"],
            exists: true,
            pathKind: "directory",
            problem: undefined,
            spec: SKILLS,
          },
        ],
        [
          "instructions",
          {
            content: "# instructions",
            exists: true,
            pathKind: "file",
            problem: undefined,
            spec: INSTRUCTIONS,
          },
        ],
      ]),
    );
  });

  it("lets an adapter turn a listed skills directory into installed skills", async () => {
    const adapter = createTestAdapter({
      files: () => [SKILLS],
      id: "alpha",
      parse: (input) =>
        createSnapshot({
          skills: (input.files.get("skills")?.entries ?? []).map((name) => ({
            appId: "alpha",
            id: `alpha/${name}`,
            name,
            path: `${SKILLS.path}/${name}`,
            scope: "global" as const,
          })),
        }),
    });

    const { model } = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createTestEnvironment(),
      reader: createMemoryReader({
        "/home/dev/.claude/skills": DIRECTORY,
        "/home/dev/.claude/skills/audit": DIRECTORY,
        "/home/dev/.claude/skills/review": DIRECTORY,
      }),
    });

    expect(model.skills.map((skill) => skill.id)).toEqual(["alpha/audit", "alpha/review"]);
  });

  it("reads a path once however many adapters and links point at it", async () => {
    const shared = "/home/dev/AGENTS.md";
    const declare = (id: string) =>
      createTestAdapter({
        files: () => [{ id: "instructions", kind: "instructions", path: shared, scope: "global" }],
        id,
        parse: () =>
          createSnapshot({ instructionFiles: [createDocument(shared, [createLink(shared)])] }),
      });

    const reader = createMemoryReader({ [shared]: "# shared" });
    await buildWorkspaceModel({
      adapters: [declare("alpha"), declare("beta")],
      environment: createTestEnvironment(),
      reader,
    });

    expect(reader.reads.filter((path) => path === shared)).toHaveLength(1);
  });

  it("resolves instruction links against the filesystem, overriding what parse claimed", async () => {
    const adapter = createTestAdapter({
      parse: () =>
        createSnapshot({
          instructionFiles: [
            createDocument("/home/dev/CLAUDE.md", [
              createLink("/home/dev/shared.md", false),
              createLink("/home/dev/gone.md", true),
            ]),
          ],
        }),
    });

    const { model } = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createTestEnvironment(),
      reader: createMemoryReader({ "/home/dev/shared.md": "# shared" }),
    });

    expect(model.instructionFiles[0]?.links.map((link) => link.valid)).toEqual([true, false]);
  });

  it("skips an application that is not installed, silently", async () => {
    const absent = createTestAdapter({
      detect: () => Promise.resolve({ installed: false }),
      id: "absent",
    });
    const present = createTestAdapter({ id: "present" });

    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [absent, present],
      environment: createTestEnvironment(),
      reader: createMemoryReader(),
    });

    expect(model.apps.map((app) => app.adapterId)).toEqual(["present"]);
    expect(diagnostics).toEqual([]);
  });

  it("resolves the project root from cwd, and omits it outside a repository", async () => {
    const options: WorkspaceScanOptions = {
      adapters: [],
      environment: createTestEnvironment({ cwd: "/workspace/packages/core" }),
      reader: createMemoryReader({ "/workspace/.git": DIRECTORY }),
    };
    const scan: WorkspaceScan = await buildWorkspaceModel(options);
    const outside = await buildWorkspaceModel({ ...options, reader: createMemoryReader() });

    expect(scan.model.projectRoot).toBe("/workspace");
    expect(outside.model.projectRoot).toBeUndefined();
  });

  it("canonicalizes cwd and home before adapters construct paths", async () => {
    let received: AdapterParseInput | undefined;
    const adapter = createTestAdapter({
      files: ({ environment }) => [
        {
          id: "instructions",
          kind: "instructions",
          path: `${environment.homeDir}/AGENTS.md`,
          scope: "global",
        },
      ],
      parse: (input) => {
        received = input;
        return createSnapshot({
          instructionFiles: [createDocument(`${input.homeDir}/AGENTS.md`)],
        });
      },
    });
    const reader = createMemoryReader(
      {
        "/private/tmp/home/AGENTS.md": "# shared",
        "/private/tmp/workspace/.git": DIRECTORY,
      },
      {
        links: {
          "/tmp/home": "/private/tmp/home",
          "/tmp/workspace": "/private/tmp/workspace",
        },
      },
    );

    const { model } = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createTestEnvironment({ cwd: "/tmp/workspace", homeDir: "/tmp/home" }),
      reader,
    });

    expect(received?.cwd).toBe("/private/tmp/workspace");
    expect(received?.homeDir).toBe("/private/tmp/home");
    expect(model).toMatchObject({
      cwd: "/private/tmp/workspace",
      homeDir: "/private/tmp/home",
      projectRoot: "/private/tmp/workspace",
    });
    expect(model.instructionFiles[0]?.path).toBe("/private/tmp/home/AGENTS.md");
  });
});
