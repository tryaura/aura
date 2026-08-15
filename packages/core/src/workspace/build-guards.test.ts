import type { AdapterFileSpec } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import {
  buildWorkspaceModel,
  type ScanDiagnostic,
  type ScanPhase,
  type SkippedApp,
} from "../index.js";
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
      detail: "spawn ENOENT",
      message:
        "Fake broken failed during detect. This is a bug in the broken adapter; report it to whoever ships the plugin.",
      phase: "detect",
    };

    expect(model.apps.map((app) => app.adapterId)).toEqual(["working"]);
    expect(model.instructionFiles).toHaveLength(1);
    expect(diagnostics).toEqual([expected]);
  });

  it("keeps a plugin's error text out of the message it shows by default", async () => {
    const broken = createTestAdapter({
      files: () => [REQUIRED],
      id: "broken",
      // What JSON.parse throws when a config file turns out to hold a credential.
      parse: () => {
        throw new Error(`Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`);
      },
    });

    const { diagnostics } = await buildWorkspaceModel({
      adapters: [broken],
      environment: createTestEnvironment(),
      reader: createMemoryReader({ "/home/dev/.codex/config.toml": "AKIAIOSFODNN7EXAMPLE" }),
    });

    expect(diagnostics[0]?.message).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(diagnostics[0]?.detail).toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("caps a plugin error long enough to be a dump rather than a diagnostic", async () => {
    const broken = createTestAdapter({
      id: "broken",
      parse: () => {
        throw new Error("x".repeat(5_000));
      },
    });

    const { diagnostics } = await buildWorkspaceModel({
      adapters: [broken],
      environment: createTestEnvironment(),
      reader: createMemoryReader(),
    });

    expect(diagnostics[0]?.detail).toHaveLength(501);
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
        detail: "unexpected TOML",
        message:
          "Fake broken failed during parse. This is a bug in the broken adapter; report it to whoever ships the plugin.",
        phase: "parse",
      },
    ]);
  });

  it("keeps scanning when an adapter returns a document without links", async () => {
    const document = createDocument("/home/dev/BROKEN.md");
    Reflect.deleteProperty(document, "links");
    const broken = createTestAdapter({
      id: "broken",
      parse: () => createSnapshot({ instructionFiles: [document] }),
    });

    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [broken, working],
      environment: createTestEnvironment(),
      reader: createMemoryReader(),
    });

    expect(model.apps.map((app) => app.adapterId)).toEqual(["broken", "working"]);
    expect(model.apps[0]).toMatchObject({
      instructionFiles: [],
      mcpServers: [],
      skills: [],
    });
    expect(model.instructionFiles.map((instruction) => instruction.path)).toEqual([
      "/home/dev/AGENTS.md",
    ]);
    expect(diagnostics).toMatchObject([
      {
        adapterId: "broken",
        message:
          "Fake broken failed during parse. This is a bug in the broken adapter; report it to whoever ships the plugin.",
        phase: "parse",
      },
    ]);
  });

  it("records an application that was looked for and not found", async () => {
    const absent = createTestAdapter({
      detect: () => Promise.resolve({ installed: false }),
      id: "absent",
    });

    const { diagnostics, skipped } = await buildWorkspaceModel({
      adapters: [absent, working],
      environment: createTestEnvironment(),
      reader: createMemoryReader(),
    });

    const expected: readonly SkippedApp[] = [{ adapterId: "absent", displayName: "Fake absent" }];

    expect(skipped).toEqual(expected);
    expect(diagnostics).toEqual([]);
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
