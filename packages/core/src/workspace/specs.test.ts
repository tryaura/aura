import type { AdapterFileSpec } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { buildWorkspaceModel } from "../index.js";
import { createMemoryReader, createTestAdapter, createTestEnvironment } from "./testing.js";

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
