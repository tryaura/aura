import type { AdapterFileSpec } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { buildWorkspaceModel } from "../index.js";
import type { FileReader } from "./reader.js";
import {
  createMemoryReader,
  createTestAdapter,
  createTestEnvironment,
  DIRECTORY,
} from "./testing.js";

const REQUIRED: AdapterFileSpec = {
  id: "config",
  kind: "config",
  path: "/home/dev/.codex/config.toml",
  scope: "global",
};

const OPTIONAL: AdapterFileSpec = {
  ...REQUIRED,
  id: "project",
  optional: true,
  path: "/workspace/.codex/config.toml",
  scope: "project",
};

describe("declared path handling", () => {
  it("uses metadata-only probes without retaining them as adapter sources", async () => {
    const probe: AdapterFileSpec = {
      id: "candidate",
      kind: "probe",
      optional: true,
      path: "/workspace/AGENTS.md",
      scope: "project",
    };
    const reader = createMemoryReader({ [probe.path]: "# instructions" });
    const adapter = createTestAdapter({ files: () => [probe] });

    const { model } = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createTestEnvironment(),
      reader,
    });

    expect(reader.probes).toContain(probe.path);
    expect(reader.reads).not.toContain(probe.path);
    expect(model.apps[0]?.sourceFiles).toEqual([]);
  });

  it("captures only the adapter-requested prefix", async () => {
    const instructions: AdapterFileSpec = {
      id: "instructions",
      kind: "instructions",
      maxBytes: 4,
      path: "/home/dev/AGENTS.md",
      scope: "global",
    };
    const adapter = createTestAdapter({
      files: () => [instructions],
      parse: ({ files }) => ({
        instructionFiles: [],
        mcpServers: [],
        metadata: { captured: files.get(instructions.id)?.content ?? "" },
        skills: [],
      }),
    });

    const { model } = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createTestEnvironment(),
      reader: createMemoryReader({ [instructions.path]: "abcdefgh" }),
    });

    expect(model.apps[0]?.metadata).toEqual({ captured: "abcd" });
  });

  it("reports a missing required path but not a missing optional one", async () => {
    const adapter = createTestAdapter({ files: () => [REQUIRED, OPTIONAL] });

    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createTestEnvironment(),
      reader: createMemoryReader(),
    });

    expect(diagnostics).toEqual([
      {
        adapterId: "fake",
        message:
          "Fake fake requires a config file at /home/dev/.codex/config.toml, but nothing exists there. Checks that rely on it were skipped.",
        path: REQUIRED.path,
        phase: "read",
      },
    ]);
    expect(model.apps[0]?.sourceFiles).toStrictEqual([
      { exists: false, problem: undefined, spec: REQUIRED },
      { exists: false, problem: undefined, spec: OPTIONAL },
    ]);
  });

  it("tells a path that cannot be read apart from one that is not there", async () => {
    const adapter = createTestAdapter({ files: () => [OPTIONAL] });

    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createTestEnvironment(),
      reader: createMemoryReader({}, { problems: { [OPTIONAL.path]: "denied" } }),
    });

    // Optional, so absence would have been silent. Being unable to read it is not absence.
    expect(diagnostics).toEqual([
      {
        adapterId: "fake",
        message:
          "Fake fake could not read its config file at /workspace/.codex/config.toml: permission was denied. Checks that rely on it were skipped.",
        path: OPTIONAL.path,
        phase: "read",
      },
    ]);
    expect(model.apps[0]?.sourceFiles[0]?.problem).toBe("denied");
  });

  it("refuses a relative spec path rather than resolving it against the process directory", async () => {
    const adapter = createTestAdapter({
      files: () => [{ ...REQUIRED, path: ".codex/config.toml" }],
    });

    const { diagnostics } = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createTestEnvironment(),
      reader: createMemoryReader(),
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ phase: "files" });
    expect(diagnostics[0]?.message).toContain("must be absolute");
  });

  it("refuses a project path that resolves outside the project", async () => {
    const spec: AdapterFileSpec = {
      id: "mcp",
      kind: "mcp",
      path: "/workspace/.mcp.json",
      scope: "project",
    };
    const adapter = createTestAdapter({ files: () => [spec] });
    const reader = createMemoryReader(
      { "/home/dev/.ssh/id_rsa": "-----BEGIN OPENSSH PRIVATE KEY-----" },
      { links: { "/workspace/.mcp.json": "/home/dev/.ssh/id_rsa" } },
    );

    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createTestEnvironment({ cwd: "/workspace" }),
      reader,
    });

    expect(reader.reads).not.toContain("/home/dev/.ssh/id_rsa");
    expect(model.apps[0]?.sourceFiles[0]).toMatchObject({
      exists: true,
      problem: "outside-project",
    });
    expect(diagnostics[0]?.message).toContain("outside /workspace");
  });

  it("reports a path that moved mid-read as changed rather than as an escape", async () => {
    const spec: AdapterFileSpec = {
      id: "mcp",
      kind: "mcp",
      path: "/workspace/.mcp.json",
      scope: "project",
    };
    const adapter = createTestAdapter({ files: () => [spec] });
    const memory = createMemoryReader({ "/workspace/.mcp.json": "{}" });
    const reader: FileReader = {
      ...memory,
      readWithin: () =>
        Promise.resolve({
          contents: { exists: true, isDirectory: false, problem: "unreadable" },
          kind: "unverified",
        }),
    };

    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createTestEnvironment({ cwd: "/workspace" }),
      reader,
    });

    expect(model.apps[0]?.sourceFiles[0]).toMatchObject({
      exists: true,
      problem: "unreadable",
    });
    expect(diagnostics[0]?.message).toContain("changed while Aura was reading it");
    // An unverifiable read is not evidence of an escape, and must not be dressed up as one.
    expect(diagnostics[0]?.message).not.toContain("outside");
  });

  it("allows project skill links only into Aura's canonical shared skill root", async () => {
    const spec: AdapterFileSpec = {
      id: "skills/review",
      kind: "skills",
      optional: true,
      path: "/workspace/.claude/skills/review",
      scope: "project",
    };
    const adapter = createTestAdapter({ files: () => [spec] });
    const reader = createMemoryReader(
      { [spec.path]: DIRECTORY, "/home/dev/agents/skills/review": DIRECTORY },
      { links: { [spec.path]: "/home/dev/agents/skills/review" } },
    );

    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createTestEnvironment({ cwd: "/workspace", homeDir: "/home/dev" }),
      reader,
    });

    expect(diagnostics).toEqual([]);
    expect(model.apps[0]?.sourceFiles[0]).toMatchObject({ exists: true, problem: undefined });
  });

  it("honors an adapter-discovered project boundary after canonicalizing it", async () => {
    const spec: AdapterFileSpec = {
      id: "instructions",
      kind: "instructions",
      path: "/workspace/AGENTS.md",
      projectBoundary: "/workspace",
      scope: "project",
    };
    const adapter = createTestAdapter({ files: () => [spec] });
    const reader = createMemoryReader({ [spec.path]: "# parent instructions" });

    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createTestEnvironment({ cwd: "/workspace/app" }),
      reader,
    });

    expect(diagnostics).toEqual([]);
    expect(model.apps[0]?.sourceFiles[0]?.exists).toBe(true);
  });

  it("rejects a relative adapter-discovered project boundary", async () => {
    const spec: AdapterFileSpec = {
      id: "instructions",
      kind: "instructions",
      path: "/workspace/AGENTS.md",
      projectBoundary: "workspace",
      scope: "project",
    };
    const adapter = createTestAdapter({ files: () => [spec] });

    const { diagnostics } = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createTestEnvironment(),
      reader: createMemoryReader(),
    });

    expect(diagnostics[0]?.message).toContain("boundaries must be absolute");
  });

  it("leaves a global path alone, since its location is the adapter's own", async () => {
    const adapter = createTestAdapter({ files: () => [REQUIRED] });
    const reader = createMemoryReader(
      { "/home/dev/.codex/config.toml": "model = 'gpt'" },
      { links: { "/home/dev/.codex/config.toml": "/elsewhere/config.toml" } },
    );

    const { diagnostics } = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createTestEnvironment({ cwd: "/workspace" }),
      reader,
    });

    expect(diagnostics).toEqual([]);
  });
});
