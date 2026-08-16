import { describe, expect, it } from "vitest";

import { runChecks } from "../checks.js";
import { buildWorkspaceModel } from "./build.js";
import { createMemoryReader, createTestEnvironment } from "./testing.js";

const PATH = "/home/dev/agents/aura.json";

describe("workspace manifest model", () => {
  it("models a missing manifest as writable desired state", async () => {
    const reader = createMemoryReader();
    const scan = await buildWorkspaceModel({
      adapters: [],
      environment: createTestEnvironment(),
      reader,
    });

    expect(scan.model.manifest).toEqual({ exists: false, path: PATH, status: "missing" });
    expect(scan.diagnostics).toEqual([]);
    expect(reader.reads.filter((path) => path === PATH)).toHaveLength(1);
  });

  it("exposes a parsed manifest to pure checks", async () => {
    const scan = await buildWorkspaceModel({
      adapters: [],
      environment: createTestEnvironment(),
      reader: createMemoryReader({
        [PATH]: JSON.stringify({
          apps: { codex: { managed: true } },
          mcpServers: [],
          ownership: {},
          schemaVersion: 1,
          skills: [],
          snippets: [],
        }),
      }),
    });

    const run = runChecks(
      [
        {
          defaultSeverity: "info",
          detect: (model) =>
            model.manifest.status === "ready" &&
            model.manifest.value.apps["codex"]?.managed === true
              ? [{ id: "seen", message: "Manifest was available." }]
              : [],
          explain: "Test manifest access.",
          fixability: "manual",
          id: "test/MANIFEST",
          scope: "global",
          title: "Manifest access",
        },
      ],
      scan.model,
    );

    expect(run.findings.map((finding) => finding.id)).toEqual(["seen"]);
  });

  it.each([
    ["corrupt", "parse"],
    ['{"schemaVersion":2}', "parse"],
  ])("keeps checks running and reports a safe core diagnostic", async (content, phase) => {
    const scan = await buildWorkspaceModel({
      adapters: [],
      environment: createTestEnvironment(),
      reader: createMemoryReader({ [PATH]: content }),
    });
    const run = runChecks(
      [
        {
          defaultSeverity: "info",
          detect: () => [{ id: "ran", message: "The check ran." }],
          explain: "Test continuation.",
          fixability: "manual",
          id: "test/CONTINUES",
          scope: "global",
          title: "Checks continue",
        },
      ],
      scan.model,
    );

    expect(scan.model.manifest.status).toBe("read-only");
    expect(scan.diagnostics).toMatchObject([{ adapterId: "core/manifest", path: PATH, phase }]);
    expect(scan.diagnostics[0]?.message).not.toContain(content);
    expect(run.findings.map((finding) => finding.id)).toEqual(["ran"]);
  });

  it("maps filesystem failures to read-only state and a read diagnostic", async () => {
    const scan = await buildWorkspaceModel({
      adapters: [],
      environment: createTestEnvironment(),
      reader: createMemoryReader({}, { problems: { [PATH]: "denied" } }),
    });

    expect(scan.model.manifest).toMatchObject({
      problem: { kind: "file", reason: "denied" },
      status: "read-only",
    });
    expect(scan.diagnostics).toMatchObject([
      { adapterId: "core/manifest", path: PATH, phase: "read" },
    ]);
  });
});
