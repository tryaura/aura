import type { AdapterFileSpec, AdapterSourceFile, Environment } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { codexAdapter } from "./adapter.js";

describe("Codex project discovery", () => {
  it("probes candidates from the repository root down to the invocation directory", () => {
    expect(projectSpecs("/repo/packages/app", "/repo")).toEqual([
      ["codex.instructions.project.2.override.probe", "/repo/AGENTS.override.md"],
      ["codex.instructions.project.2.probe", "/repo/AGENTS.md"],
      ["codex.instructions.project.1.override.probe", "/repo/packages/AGENTS.override.md"],
      ["codex.instructions.project.1.probe", "/repo/packages/AGENTS.md"],
      ["codex.instructions.project.override.probe", "/repo/packages/app/AGENTS.override.md"],
      ["codex.instructions.project.probe", "/repo/packages/app/AGENTS.md"],
    ]);
  });

  it("declares only the invocation directory without a repository", () => {
    expect(projectSpecs("/elsewhere/scratch", undefined)).toEqual([
      ["codex.instructions.project.override.probe", "/elsewhere/scratch/AGENTS.override.md"],
      ["codex.instructions.project.probe", "/elsewhere/scratch/AGENTS.md"],
    ]);
  });

  it("falls back to the invocation directory when it is outside the reported root", () => {
    expect(projectSpecs("/elsewhere", "/repo")).toEqual([
      ["codex.instructions.project.override.probe", "/elsewhere/AGENTS.override.md"],
      ["codex.instructions.project.probe", "/elsewhere/AGENTS.md"],
    ]);
  });

  it("uses configured fallback filenames after standard candidates are absent", () => {
    const config = configSource('project_doc_fallback_filenames = ["CLAUDE.md"]\n');
    const testEnvironment = environment("/repo/app");
    const first = declareFiles(testEnvironment, new Map([entry(config)]), "/repo");
    const probes = first.filter(
      (spec) => spec.kind === "probe" && spec.id.startsWith("codex.instructions.project"),
    );
    const files = new Map<string, AdapterSourceFile>([entry(config)]);
    for (const probe of probes) {
      files.set(probe.id, {
        exists: probe.path === "/repo/CLAUDE.md",
        ...(probe.path === "/repo/CLAUDE.md" ? { pathKind: "file", size: 12 } : {}),
        spec: probe,
      });
    }

    const selected = declareFiles(testEnvironment, files, "/repo").filter(
      (spec) => spec.kind === "instructions" && spec.scope === "project",
    );

    expect(selected).toEqual([
      {
        id: "codex.instructions.project.1.fallback.0",
        kind: "instructions",
        maxBytes: 32_768,
        optional: true,
        path: "/repo/CLAUDE.md",
        scope: "project",
      },
    ]);
  });

  it("bounds selected reads by the aggregate project document budget", () => {
    const config = configSource("project_doc_max_bytes = 8\n");
    const testEnvironment = environment("/repo/app");
    const first = declareFiles(testEnvironment, new Map([entry(config)]), "/repo");
    const files = new Map<string, AdapterSourceFile>([entry(config)]);
    for (const probe of first.filter(
      (spec) => spec.kind === "probe" && spec.id.startsWith("codex.instructions.project"),
    )) {
      const selected = probe.path === "/repo/AGENTS.md" || probe.path === "/repo/app/AGENTS.md";
      files.set(probe.id, {
        exists: selected,
        ...(selected ? { pathKind: "file", size: 6 } : {}),
        spec: probe,
      });
    }

    const declarations = declareFiles(testEnvironment, files, "/repo").filter(
      (spec) => spec.kind === "instructions" && spec.scope === "project",
    );

    expect(declarations.map((spec) => [spec.path, spec.maxBytes])).toEqual([
      ["/repo/AGENTS.md", 8],
      ["/repo/app/AGENTS.md", 2],
    ]);
  });

  it("refuses configured fallback paths that could escape their level", () => {
    const config = configSource(
      'project_doc_fallback_filenames = ["../outside.md", "nested/rules.md", "CLAUDE.md"]\n',
    );
    const paths = declareFiles(environment("/repo"), new Map([entry(config)]), "/repo")
      .filter((spec) => spec.id.startsWith("codex.instructions.project"))
      .map((spec) => spec.path);

    expect(paths).toEqual(["/repo/AGENTS.override.md", "/repo/AGENTS.md", "/repo/CLAUDE.md"]);
  });

  it("uses a configured root marker without requiring Git", () => {
    const config = configSource('project_root_markers = ["package.json"]\n');
    const testEnvironment = environment("/workspace/app");
    const first = declareFiles(testEnvironment, new Map([entry(config)]), undefined);
    const files = new Map<string, AdapterSourceFile>([entry(config)]);
    for (const probe of first.filter((spec) => spec.id.startsWith("codex.project-root."))) {
      files.set(probe.id, {
        exists: probe.path === "/workspace/package.json",
        ...(probe.path === "/workspace/package.json" ? { pathKind: "file", size: 2 } : {}),
        spec: probe,
      });
    }

    const candidates = declareFiles(testEnvironment, files, undefined).filter((spec) =>
      spec.id.startsWith("codex.instructions.project"),
    );

    expect(candidates.map((spec) => spec.path)).toEqual([
      "/workspace/AGENTS.override.md",
      "/workspace/AGENTS.md",
      "/workspace/app/AGENTS.override.md",
      "/workspace/app/AGENTS.md",
    ]);
    expect(candidates.map((spec) => spec.projectBoundary)).toEqual([
      "/workspace",
      "/workspace",
      "/workspace",
      "/workspace",
    ]);
  });

  it("disables parent traversal when project_root_markers is empty", () => {
    const config = configSource("project_root_markers = []\n");
    const candidates = declareFiles(
      environment("/repo/packages/app"),
      new Map([entry(config)]),
      "/repo",
    ).filter((spec) => spec.id.startsWith("codex.instructions.project"));

    expect(candidates.map((spec) => spec.path)).toEqual([
      "/repo/packages/app/AGENTS.override.md",
      "/repo/packages/app/AGENTS.md",
    ]);
  });

  it("does not truncate discovery after sixty-four ancestors", () => {
    const segments = Array.from({ length: 70 }, (_, index) => `level-${String(index)}`);
    expect(projectSpecs(`/repo/${segments.join("/")}`, "/repo")).toHaveLength(
      (segments.length + 1) * 2,
    );
  });
});

function projectSpecs(
  cwd: string,
  projectRoot: string | undefined,
): readonly (readonly [string, string])[] {
  return declareFiles(environment(cwd), new Map([entry(configSource(""))]), projectRoot)
    .filter((spec) => spec.kind === "probe" && spec.id.startsWith("codex.instructions.project"))
    .map((spec) => [spec.id, spec.path] as const);
}

function declareFiles(
  environment: Environment,
  files: ReadonlyMap<string, AdapterSourceFile>,
  projectRoot: string | undefined,
): readonly AdapterFileSpec[] {
  return codexAdapter.files({ detection: { installed: true }, environment, files, projectRoot });
}

function configSource(content: string): AdapterSourceFile {
  return {
    content,
    exists: true,
    spec: {
      id: "codex.mcp.global",
      kind: "mcp",
      path: "/home/dev/.codex/config.toml",
      scope: "global",
    },
  };
}

function environment(cwd: string): Environment {
  return {
    cwd,
    exec: () => Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }),
    homeDir: "/home/dev",
    httpGet: () => Promise.resolve({ kind: "failure", reason: "network" }),
    now: () => new Date(0),
    pathEntries: [],
    platform: "linux",
    readVariable: () => undefined,
  };
}

function entry(file: AdapterSourceFile): readonly [string, AdapterSourceFile] {
  return [file.spec.id, file];
}
