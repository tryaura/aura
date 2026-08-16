import type {
  AdapterFileKind,
  AdapterFileSpec,
  AdapterSourceFile,
  Environment,
  Scope,
} from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { codexAdapter } from "./adapter.js";

describe("Codex project scope", () => {
  it("declares one AGENTS.md per directory from the repository root down to the invocation directory", () => {
    expect(projectSpecs("/repo/packages/app", "/repo")).toEqual([
      ["codex.instructions.project.2.override", "/repo/AGENTS.override.md"],
      ["codex.instructions.project.2", "/repo/AGENTS.md"],
      ["codex.instructions.project.1.override", "/repo/packages/AGENTS.override.md"],
      ["codex.instructions.project.1", "/repo/packages/AGENTS.md"],
      ["codex.instructions.project.override", "/repo/packages/app/AGENTS.override.md"],
      ["codex.instructions.project", "/repo/packages/app/AGENTS.md"],
    ]);
  });

  it("declares only the invocation directory when no repository contains it", () => {
    expect(projectSpecs("/elsewhere/scratch", undefined)).toEqual([
      ["codex.instructions.project.override", "/elsewhere/scratch/AGENTS.override.md"],
      ["codex.instructions.project", "/elsewhere/scratch/AGENTS.md"],
    ]);
  });

  it("falls back to the invocation directory when it is not inside the reported root", () => {
    expect(projectSpecs("/elsewhere", "/repo")).toEqual([
      ["codex.instructions.project.override", "/elsewhere/AGENTS.override.md"],
      ["codex.instructions.project", "/elsewhere/AGENTS.md"],
    ]);
  });

  it("parses every declared level in scope order, root before invocation directory", () => {
    const snapshot = codexAdapter.parse({
      cwd: "/repo/packages/app",
      detection: { installed: true },
      files: new Map([
        entry(source("codex.instructions.global", "/home/dev/.codex/AGENTS.md", "global", "# G\n")),
        entry(source("codex.instructions.project.2", "/repo/AGENTS.md", "project", "# Root\n")),
        entry(
          source("codex.instructions.project", "/repo/packages/app/AGENTS.md", "project", "# P\n"),
        ),
      ]),
      homeDir: "/home/dev",
      projectRoot: "/repo",
    });

    expect(snapshot.instructionFiles.map((file) => [file.path, file.scope, file.content])).toEqual([
      ["/home/dev/.codex/AGENTS.md", "global", "# G\n"],
      ["/repo/AGENTS.md", "project", "# Root\n"],
      ["/repo/packages/app/AGENTS.md", "project", "# P\n"],
    ]);
  });

  it("takes the override Codex prefers, and says so when it shadows the shared-link entry", () => {
    const snapshot = codexAdapter.parse({
      cwd: "/workspace",
      detection: { installed: true },
      files: new Map([
        entry(
          source(
            "codex.instructions.global.override",
            "/home/dev/.codex/AGENTS.override.md",
            "global",
            "# Global override\n",
          ),
        ),
        entry(
          source("codex.instructions.global", "/home/dev/.codex/AGENTS.md", "global", "# Global\n"),
        ),
        entry(
          source(
            "codex.instructions.project.override",
            "/workspace/AGENTS.override.md",
            "project",
            "# Project override\n",
          ),
        ),
        entry(source("codex.instructions.project", "/workspace/AGENTS.md", "project", "# P\n")),
      ]),
      homeDir: "/home/dev",
    });

    expect(snapshot.instructionFiles.map((file) => file.path)).toEqual([
      "/home/dev/.codex/AGENTS.override.md",
      "/workspace/AGENTS.override.md",
    ]);
    // Only the global entry is worth a word: a repository shadowing its own AGENTS.md is ordinary,
    // but ~/.codex/AGENTS.md is where INS-002 puts the shared link, and Codex is now ignoring it.
    expect(snapshot.problems).toEqual([
      {
        message:
          "Codex reads AGENTS.override.md instead of /home/dev/.codex/AGENTS.md, so whatever that file loads — including Aura's shared instruction link — is not reaching Codex. Move the guidance into the override file, or remove it.",
        sourceId: "codex.instructions.global",
      },
    ]);
  });

  it("falls back to the AGENTS.md beside an override that holds nothing", () => {
    const snapshot = codexAdapter.parse({
      cwd: "/workspace",
      detection: { installed: true },
      files: new Map([
        entry(
          source(
            "codex.instructions.project.override",
            "/workspace/AGENTS.override.md",
            "project",
            "   \n",
          ),
        ),
        entry(source("codex.instructions.project", "/workspace/AGENTS.md", "project", "# P\n")),
      ]),
      homeDir: "/home/dev",
    });

    expect(snapshot.instructionFiles.map((file) => file.path)).toEqual(["/workspace/AGENTS.md"]);
    expect(snapshot.problems).toEqual([]);
  });

  it("models a symlinked project AGENTS.md as a link for INS-002 to judge", () => {
    const snapshot = codexAdapter.parse({
      cwd: "/workspace",
      detection: { installed: true },
      files: new Map([
        entry({
          ...source("codex.instructions.project", "/workspace/AGENTS.md", "project", "# Shared\n"),
          pathKind: "symlink",
          // Inside the project: core refuses to read a project path that resolves anywhere else,
          // so a link out to the home directory never reaches parse at all.
          symlinkTarget: "docs/AGENTS.md",
        }),
      ]),
      homeDir: "/home/dev",
    });

    expect(snapshot.instructionFiles).toEqual([
      {
        content: "# Shared\n",
        links: [{ kind: "symlink", targetPath: "/workspace/docs/AGENTS.md", valid: false }],
        path: "/workspace/AGENTS.md",
        scope: "project",
        sourceId: "codex.instructions.project",
      },
    ]);
  });

  it("keeps a dangling symlink, which carries no contents but a link worth reporting", () => {
    const snapshot = codexAdapter.parse({
      cwd: "/workspace",
      detection: { installed: true },
      files: new Map([
        entry({
          exists: true,
          pathKind: "symlink",
          spec: specFor("codex.instructions.project", "/workspace/AGENTS.md", "project"),
          symlinkTarget: "/home/dev/agents/AGENTS.md",
        }),
      ]),
      homeDir: "/home/dev",
    });

    expect(snapshot.instructionFiles).toEqual([
      {
        content: "",
        links: [{ kind: "symlink", targetPath: "/home/dev/agents/AGENTS.md", valid: false }],
        path: "/workspace/AGENTS.md",
        scope: "project",
        sourceId: "codex.instructions.project",
      },
    ]);
  });

  it("claims nothing about a project path core refused to read, a directory, or one that is absent", () => {
    const refused: AdapterSourceFile = {
      exists: true,
      problem: "outside-project",
      spec: specFor("codex.instructions.project", "/workspace/AGENTS.md", "project"),
    };
    // A repository is free to ship a folder by that name; it still holds no guidance.
    const directory: AdapterSourceFile = {
      entries: ["one.md", "two.md"],
      exists: true,
      pathKind: "directory",
      spec: specFor("codex.instructions.project", "/workspace/AGENTS.md", "project"),
    };

    for (const file of [refused, directory]) {
      expect(
        codexAdapter.parse({
          cwd: "/workspace",
          detection: { installed: true },
          files: new Map([entry(file)]),
          homeDir: "/home/dev",
        }).instructionFiles,
      ).toEqual([]);
    }
    expect(
      codexAdapter.parse({
        cwd: "/workspace",
        detection: { installed: true },
        files: new Map(),
        homeDir: "/home/dev",
      }).instructionFiles,
    ).toEqual([]);
  });

  it("keeps MCP servers when the projects table is malformed", () => {
    const config = source(
      "codex.mcp.global",
      "/home/dev/.codex/config.toml",
      "global",
      ['projects = "nope"', "", "[mcp_servers.docs]", 'command = "npx"', ""].join("\n"),
      "mcp",
    );
    const snapshot = codexAdapter.parse({
      cwd: "/workspace",
      detection: { installed: true },
      files: new Map([entry(config)]),
      homeDir: "/home/dev",
      projectRoot: "/workspace",
    });

    expect(snapshot.mcpServers.map((server) => server.name)).toEqual(["docs"]);
    expect(snapshot.metadata).toEqual({ projectTrust: "unknown" });
  });
});

/** The project-scoped instruction slots the adapter declares, as `[id, path]` in declared order. */
function projectSpecs(
  cwd: string,
  projectRoot: string | undefined,
): readonly (readonly [string, string])[] {
  return codexAdapter
    .files(environment(cwd), { installed: true }, new Map(), projectRoot)
    .filter((spec) => spec.scope === "project")
    .map((spec) => [spec.id, spec.path] as const);
}

function environment(cwd: string): Environment {
  return {
    cwd,
    exec: () => Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }),
    homeDir: "/home/dev",
    now: () => new Date(0),
    pathEntries: [],
    platform: "linux",
  };
}

function entry(file: AdapterSourceFile): readonly [string, AdapterSourceFile] {
  return [file.spec.id, file];
}

function specFor(
  id: string,
  path: string,
  scope: Scope,
  kind: AdapterFileKind = "instructions",
): AdapterFileSpec {
  return { id, kind, path, scope };
}

function source(
  id: string,
  path: string,
  scope: Scope,
  content: string,
  kind: AdapterFileKind = "instructions",
): AdapterSourceFile {
  return { content, exists: true, spec: specFor(id, path, scope, kind) };
}
