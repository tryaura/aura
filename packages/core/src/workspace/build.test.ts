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
      { exists: true, spec: INSTRUCTIONS },
      { exists: true, spec: SKILLS },
    ]);
  });

  it("hands parse one entry per declared spec, in order, with directories left unread", async () => {
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
        "/home/dev/CLAUDE.md": "# instructions",
      }),
    });

    expect(received?.detection).toEqual({ installed: true, version: "1.0.0" });
    expect(received?.files).toStrictEqual([
      { content: undefined, exists: true, spec: SKILLS },
      { content: "# instructions", exists: true, spec: INSTRUCTIONS },
    ]);
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
});
