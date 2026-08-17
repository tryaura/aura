import type { AdapterFileMap, AdapterSourceFile } from "./adapter.js";
import type { AdapterSkillDirectory } from "./capabilities.js";
import { describe, expect, it } from "vitest";

import { parseInstalledSkills, parseSkillFrontmatter, resolveSkillDirectory } from "./skill.js";

const DIRECTORY: AdapterSkillDirectory = {
  entryPath: "~/.codex/skills",
  id: "codex.skills.global",
};

describe("skill adapter helpers", () => {
  it("resolves global and project directory declarations", () => {
    expect(resolveSkillDirectory(DIRECTORY, "/home/dev", "/workspace")).toEqual({
      id: "codex.skills.global",
      path: "/home/dev/.codex/skills",
      scope: "global",
    });
    expect(
      resolveSkillDirectory(
        { entryPath: "./.claude/skills", id: "claude.skills.project" },
        "/home/dev",
        "/workspace",
      ),
    ).toEqual({
      id: "claude.skills.project",
      path: "/workspace/.claude/skills",
      scope: "project",
    });
  });

  it("parses required names and standard metadata versions", () => {
    expect(
      parseSkillFrontmatter(
        "---\nname: review\nversion: 1.0.0\nmetadata:\n  version: 2.3.4\n---\n# Review\n",
      ),
    ).toEqual({ name: "review", version: "2.3.4" });
    expect(parseSkillFrontmatter("---\nname: review\nversion: 1.0.0\n---\n")).toEqual({
      name: "review",
      version: "1.0.0",
    });
  });

  it("models healthy skill directories and ignores foreign entries or missing names", () => {
    const files: AdapterFileMap = new Map([
      [
        DIRECTORY.id,
        source(DIRECTORY.id, "/home/dev/.codex/skills", ["foreign", "invalid", "review"]),
      ],
      [
        `${DIRECTORY.id}/review`,
        source(`${DIRECTORY.id}/review`, "/home/dev/.codex/skills/review", ["SKILL.md"], "symlink"),
      ],
      [
        `${DIRECTORY.id}/review/SKILL.md`,
        source(
          `${DIRECTORY.id}/review/SKILL.md`,
          "/home/dev/.codex/skills/review/SKILL.md",
          undefined,
          "file",
          "---\nname: review\nmetadata:\n  version: 2.3.4\n---\n",
        ),
      ],
      [
        `${DIRECTORY.id}/invalid`,
        source(`${DIRECTORY.id}/invalid`, "/home/dev/.codex/skills/invalid", ["SKILL.md"]),
      ],
      [
        `${DIRECTORY.id}/invalid/SKILL.md`,
        source(
          `${DIRECTORY.id}/invalid/SKILL.md`,
          "/home/dev/.codex/skills/invalid/SKILL.md",
          undefined,
          "file",
          "---\ndescription: Missing name\n---\n",
        ),
      ],
      [
        `${DIRECTORY.id}/foreign`,
        source(
          `${DIRECTORY.id}/foreign`,
          "/home/dev/.codex/skills/foreign",
          undefined,
          "file",
          "foreign",
        ),
      ],
    ]);

    expect(
      parseInstalledSkills(
        "codex",
        { cwd: "/workspace", detection: { installed: true }, files, homeDir: "/home/dev" },
        [DIRECTORY],
      ),
    ).toEqual([
      {
        appId: "codex",
        id: "review",
        name: "review",
        path: "/home/dev/.codex/skills/review",
        scope: "global",
        sourceId: "codex.skills.global",
        version: "2.3.4",
      },
    ]);
  });
});

function source(
  id: string,
  path: string,
  entries?: readonly string[],
  pathKind: "directory" | "file" | "symlink" = "directory",
  content?: string,
): AdapterSourceFile {
  return {
    ...(content === undefined ? {} : { content }),
    ...(entries === undefined ? {} : { entries }),
    exists: true,
    pathKind,
    problem: undefined,
    spec: { id, kind: "skills", optional: true, path, scope: "global" },
  };
}
