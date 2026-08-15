import type { AdapterFileSpec } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { buildWorkspaceModel, type ScanDiagnostic, type ScanPhase } from "../index.js";
import {
  createDocument,
  createMemoryReader,
  createSnapshot,
  createTestAdapter,
  createTestEnvironment,
} from "./testing.js";

const REQUIRED: AdapterFileSpec = {
  id: "config",
  kind: "config",
  path: "/home/dev/.codex/config.toml",
  scope: "global",
};

const OPTIONAL: AdapterFileSpec = { ...REQUIRED, id: "project", optional: true, scope: "project" };

const working = createTestAdapter({
  id: "working",
  parse: () => createSnapshot({ instructionFiles: [createDocument("/home/dev/AGENTS.md")] }),
});

describe("buildWorkspaceModel guards", () => {
  it("drops an adapter whose detection rejects, and scans the rest", async () => {
    const broken = createTestAdapter({
      detect: () => Promise.reject(new Error("spawn ENOENT")),
      id: "broken",
    });

    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [broken, working],
      environment: createTestEnvironment(),
      reader: createMemoryReader(),
    });

    const expected: ScanDiagnostic = {
      adapterId: "broken",
      message: "Fake broken failed during detect: spawn ENOENT",
      phase: "detect",
    };

    expect(model.apps.map((app) => app.adapterId)).toEqual(["working"]);
    expect(model.instructionFiles).toHaveLength(1);
    expect(diagnostics).toEqual([expected]);
  });

  it("drops an adapter whose file declaration throws", async () => {
    const broken = createTestAdapter({
      files: () => {
        throw new Error("no home");
      },
      id: "broken",
    });

    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [broken, working],
      environment: createTestEnvironment(),
      reader: createMemoryReader(),
    });

    const phases: readonly ScanPhase[] = diagnostics.map((diagnostic) => diagnostic.phase);

    expect(model.apps.map((app) => app.adapterId)).toEqual(["working"]);
    expect(phases).toEqual(["files"]);
  });

  it("keeps an application whose parse throws, with an empty snapshot", async () => {
    const broken = createTestAdapter({
      files: () => [REQUIRED],
      id: "broken",
      parse: () => {
        throw new Error("unexpected TOML");
      },
    });

    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [broken],
      environment: createTestEnvironment(),
      reader: createMemoryReader({ "/home/dev/.codex/config.toml": "model = 'gpt'" }),
    });

    expect(model.apps[0]).toMatchObject({
      adapterId: "broken",
      instructionFiles: [],
      mcpServers: [],
      skills: [],
      sourceFiles: [{ exists: true, spec: REQUIRED }],
      support: { status: "supported" },
    });
    expect(diagnostics).toEqual([
      {
        adapterId: "broken",
        message: "Fake broken failed during parse: unexpected TOML",
        phase: "parse",
      },
    ]);
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
        message: "Fake fake expects config at this path, but it does not exist.",
        path: REQUIRED.path,
        phase: "read",
      },
    ]);
    expect(model.apps[0]?.sourceFiles).toStrictEqual([
      { exists: false, spec: REQUIRED },
      { exists: false, spec: OPTIONAL },
    ]);
  });

  it("reports an adapter whose supported range does not parse", async () => {
    const adapter = createTestAdapter({ supportedRange: "whatever ships" });

    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createTestEnvironment(),
      reader: createMemoryReader(),
    });

    expect(model.apps[0]?.support).toEqual({
      status: "unknown",
      supportedRange: "whatever ships",
      version: "1.0.0",
    });
    expect(diagnostics.map((diagnostic) => diagnostic.phase)).toEqual(["support"]);
  });

  it("marks a detected version outside the supported range as unsupported", async () => {
    const adapter = createTestAdapter({
      detect: () => Promise.resolve({ installed: true, version: "3.1.0" }),
      supportedRange: ">=1 <2",
    });

    const { model } = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createTestEnvironment(),
      reader: createMemoryReader(),
    });

    expect(model.apps[0]?.support).toEqual({
      status: "unsupported",
      supportedRange: ">=1 <2",
      version: "3.1.0",
    });
  });
});
