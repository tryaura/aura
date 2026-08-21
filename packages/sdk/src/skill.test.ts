import type { AdapterFileMap, AdapterSourceFile } from "./adapter.js";
import type { AdapterSkillDirectory } from "./capabilities.js";
import { describe, expect, it } from "vitest";

import {
  parseInstalledSkills,
  parseSkillFrontmatter,
  parseSkillReferences,
  resolveSkillDirectory,
} from "./skill.js";

const DIRECTORY: AdapterSkillDirectory = {
  entryPath: "~/.codex/skills",
  id: "codex.skills.global",
};

describe("skill adapter helpers", () => {
  it("resolves a global directory declaration", () => {
    expect(resolveSkillDirectory(DIRECTORY, "/home/dev")).toEqual({
      id: "codex.skills.global",
      path: "/home/dev/.codex/skills",
    });
  });

  it("parses required names and standard metadata versions", () => {
    expect(
      parseSkillFrontmatter(
        "---\nname: review\nversion: 1.0.0\nmetadata:\n  version: 2.3.4\n---\n# Review\n",
      ),
    ).toEqual({ invalidFields: [], name: "review", parsed: true, version: "2.3.4" });
    expect(parseSkillFrontmatter("---\nname: review\nversion: 1.0.0\n---\n")).toEqual({
      invalidFields: [],
      name: "review",
      parsed: true,
      version: "1.0.0",
    });
  });

  it("marks malformed YAML and non-string fields without throwing", () => {
    expect(parseSkillFrontmatter("---\nname: [broken\n---\n")).toEqual({
      invalidFields: [],
      parsed: false,
    });
    expect(parseSkillFrontmatter("---\nname: 42\ndescription: valid\n---\n")).toEqual({
      description: "valid",
      invalidFields: ["name"],
      parsed: true,
    });
  });

  it("collects only local references inside the skill root and masks code", () => {
    const references = parseSkillReferences(
      [
        "See [guide](references/guide.md) and @./scripts/check.ts.",
        "Ignore [outside](../outside.md), [web](https://example.com), and `@./literal.md`.",
      ].join("\n"),
      {
        homeDir: "/home/dev",
        skillRoot: "/home/dev/agents/skills/review",
        sourcePath: "/home/dev/agents/skills/review/SKILL.md",
      },
    );

    expect(references).toEqual([
      { path: "/home/dev/agents/skills/review/scripts/check.ts", valid: false },
      { path: "/home/dev/agents/skills/review/references/guide.md", valid: false },
    ]);
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
        definitionStatus: "ready",
        description: "Missing name",
        id: "invalid",
        name: "invalid",
        path: "/home/dev/.codex/skills/invalid",
        skillFilePath: "/home/dev/.codex/skills/invalid/SKILL.md",
        sourceId: "codex.skills.global",
      },
      {
        appId: "codex",
        definitionStatus: "ready",
        id: "review",
        name: "review",
        path: "/home/dev/.codex/skills/review",
        skillFilePath: "/home/dev/.codex/skills/review/SKILL.md",
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
