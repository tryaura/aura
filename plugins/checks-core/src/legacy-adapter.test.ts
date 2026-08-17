import type { AdapterSourceFile, Environment, ExecResult } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import checksCore from "./index.js";
import { LEGACY_INSTRUCTIONS_ADAPTER_ID, legacyInstructionsAdapter } from "./legacy-adapter.js";

const LEGACY_NAMES = [".cursorrules", ".windsurfrules", ".clinerules", "AMPCODE.md", ".goosehints"];

const CURRENT_NAMES = ["GEMINI.md", "CRUSH.md", "WARP.md", ".github/copilot-instructions.md"];

const INVENTORY_NAMES = [...LEGACY_NAMES, ...CURRENT_NAMES];

describe("legacy instruction inventory adapter", () => {
  it("is registered and always reports a supported synthetic installation", async () => {
    expect(checksCore.adapters).toContain(legacyInstructionsAdapter);
    await expect(legacyInstructionsAdapter.detect()).resolves.toEqual({
      installed: true,
      version: "1.0.0",
    });
  });

  it("declares every inventoried path at home, the repository root, and the invocation directory", () => {
    const specs = legacyInstructionsAdapter.files({
      detection: { installed: true },
      environment: environment(),
      files: new Map(),
      projectRoot: "/repo",
    });

    expect(specs).toHaveLength(27);
    expect(specs.map((spec) => spec.path)).toEqual([
      ...INVENTORY_NAMES.map((name) => `/home/dev/${name}`),
      ...INVENTORY_NAMES.map((name) => `/repo/${name}`),
      ...INVENTORY_NAMES.map((name) => `/repo/packages/app/${name}`),
    ]);
    expect(new Set(specs.map((spec) => spec.id)).size).toBe(specs.length);
    expect(specs.every((spec) => spec.kind === "instructions" && spec.optional === true)).toBe(
      true,
    );
  });

  it("keeps current instruction formats in the inventory so other checks still see them", () => {
    const specs = legacyInstructionsAdapter.files({
      detection: { installed: true },
      environment: { ...environment(), cwd: "/repo" },
      files: new Map(),
      projectRoot: "/repo",
    });
    const current = specs.filter((spec) =>
      CURRENT_NAMES.some((name) => spec.path.endsWith(`/${name}`)),
    );

    // Both scopes of each: they are inventoried exactly as the legacy names are.
    expect(current).toHaveLength(CURRENT_NAMES.length * 2);
  });

  it("declares each project base once when the repository root is the invocation directory", () => {
    const specs = legacyInstructionsAdapter.files({
      detection: { installed: true },
      environment: { ...environment(), cwd: "/repo" },
      files: new Map(),
      projectRoot: "/repo",
    });

    expect(specs.map((spec) => spec.path)).toEqual([
      ...INVENTORY_NAMES.map((name) => `/home/dev/${name}`),
      ...INVENTORY_NAMES.map((name) => `/repo/${name}`),
    ]);
  });

  it("parses readable files with stable legacy metadata and source ids", () => {
    const specs = legacyInstructionsAdapter.files({
      detection: { installed: true },
      environment: environment(),
      files: new Map(),
      projectRoot: "/repo",
    });
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

    // Two names at each of the three bases, and the tool survives the per-base id suffix. A current
    // format is inventoried beside a legacy one, distinguished only by the flag INS-004 reads.
    expect(snapshot.instructionFiles).toHaveLength(6);
    expect(snapshot.instructionFiles.map((document) => document.metadata)).toEqual([
      { legacy: true, tool: "windsurf" },
      { legacy: false, tool: "gemini" },
      { legacy: true, tool: "windsurf" },
      { legacy: false, tool: "gemini" },
      { legacy: true, tool: "windsurf" },
      { legacy: false, tool: "gemini" },
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
