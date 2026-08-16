import type { AdapterSourceFile, Environment, ExecResult } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import checksCore from "./index.js";
import { LEGACY_INSTRUCTIONS_ADAPTER_ID, legacyInstructionsAdapter } from "./legacy-adapter.js";

const LEGACY_NAMES = [
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
  "GEMINI.md",
  "CRUSH.md",
  "WARP.md",
  "AMPCODE.md",
  ".goosehints",
  ".github/copilot-instructions.md",
];

describe("legacy instruction inventory adapter", () => {
  it("is registered and always reports a supported synthetic installation", async () => {
    expect(checksCore.adapters).toContain(legacyInstructionsAdapter);
    await expect(legacyInstructionsAdapter.detect()).resolves.toEqual({
      installed: true,
      version: "1.0.0",
    });
  });

  it("declares every legacy path at home, the repository root, and the invocation directory", () => {
    const specs = legacyInstructionsAdapter.files(
      environment(),
      { installed: true },
      new Map(),
      "/repo",
    );

    expect(specs).toHaveLength(27);
    expect(specs.map((spec) => spec.path)).toEqual([
      ...LEGACY_NAMES.map((name) => `/home/dev/${name}`),
      ...LEGACY_NAMES.map((name) => `/repo/${name}`),
      ...LEGACY_NAMES.map((name) => `/repo/packages/app/${name}`),
    ]);
    expect(new Set(specs.map((spec) => spec.id)).size).toBe(specs.length);
    expect(specs.every((spec) => spec.kind === "instructions" && spec.optional === true)).toBe(
      true,
    );
  });

  it("declares each project base once when the repository root is the invocation directory", () => {
    const specs = legacyInstructionsAdapter.files(
      { ...environment(), cwd: "/repo" },
      { installed: true },
      new Map(),
      "/repo",
    );

    expect(specs.map((spec) => spec.path)).toEqual([
      ...LEGACY_NAMES.map((name) => `/home/dev/${name}`),
      ...LEGACY_NAMES.map((name) => `/repo/${name}`),
    ]);
  });

  it("parses readable files with stable legacy metadata and source ids", () => {
    const specs = legacyInstructionsAdapter.files(
      environment(),
      { installed: true },
      new Map(),
      "/repo",
    );
    const selected = specs.filter(
      (spec) => spec.path.endsWith(".windsurfrules") || spec.path.endsWith("GEMINI.md"),
    );
    const files = new Map(
      selected.map((spec): readonly [string, AdapterSourceFile] => [
        spec.id,
        { content: `# ${spec.id}\n`, exists: true, pathKind: "file", spec },
      ]),
    );

    const snapshot = legacyInstructionsAdapter.parse({
      cwd: "/repo/packages/app",
      detection: { installed: true, version: "1.0.0" },
      files,
      homeDir: "/home/dev",
      projectRoot: "/repo",
    });

    // Two names at each of the three bases, and the tool survives the per-base id suffix.
    expect(snapshot.instructionFiles).toHaveLength(6);
    expect(snapshot.instructionFiles.map((document) => document.metadata)).toEqual([
      { legacy: true, tool: "windsurf" },
      { legacy: true, tool: "gemini" },
      { legacy: true, tool: "windsurf" },
      { legacy: true, tool: "gemini" },
      { legacy: true, tool: "windsurf" },
      { legacy: true, tool: "gemini" },
    ]);
    expect(
      snapshot.instructionFiles.every((document) =>
        document.sourceId.startsWith(`${LEGACY_INSTRUCTIONS_ADAPTER_ID}.`),
      ),
    ).toBe(true);
  });
});

function environment(): Environment {
  const result: ExecResult = { exitCode: 0, stderr: "", stdout: "" };
  return {
    cwd: "/repo/packages/app",
    exec: async () => result,
    homeDir: "/home/dev",
    now: () => new Date(0),
    pathEntries: [],
    platform: "linux",
  };
}
