import type { AdapterSourceFile } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { parseInstructionFile } from "./instructions.js";

describe("Codex native instructions", () => {
  it("preserves a real file without claiming it links to shared instructions", () => {
    expect(parseInstructionFile(instructionFile("# Personal rules\n"), HOME)).toEqual({
      content: "# Personal rules\n",
      links: [],
      path: "/home/dev/.codex/AGENTS.md",
      scope: "global",
      sourceId: "codex.instructions.global",
    });
  });

  it("reports the raw target of a symbolic link", () => {
    expect(
      parseInstructionFile(
        {
          ...instructionFile("# Shared\n"),
          pathKind: "symlink",
          symlinkTarget: "../agents/AGENTS.md",
        },
        HOME,
      ).links,
    ).toEqual([{ kind: "symlink", targetPath: "/home/dev/agents/AGENTS.md", valid: false }]);
  });

  it("handles empty content without inventing instructions", () => {
    expect(parseInstructionFile(instructionFile(undefined), HOME).content).toBe("");
  });

  it("retains import-shaped references for unsupported-import diagnostics", () => {
    expect(
      parseInstructionFile(
        instructionFile(
          "Use @~/agents/AGENTS.md and @./project.md, but not @alice or `@./code.md`.\n",
        ),
        HOME,
      ).links,
    ).toEqual([
      { kind: "import", targetPath: "/home/dev/agents/AGENTS.md", valid: false },
      { kind: "import", targetPath: "/home/dev/.codex/project.md", valid: false },
    ]);
  });

  it("leaves prose that merely looks like a path alone", () => {
    expect(
      parseInstructionFile(
        instructionFile("Ping @example.com about @v1.2, and ask @Jan.Kowalski to review.\n"),
        HOME,
      ).links,
    ).toEqual([]);
  });

  it("parses the truncated content Codex would actually read", () => {
    const document = parseInstructionFile(instructionFile("Read @./full.md.\n"), {
      ...HOME,
      content: "Read @./trunc",
    });

    expect(document.content).toBe("Read @./trunc");
    expect(document.links).toEqual([
      { kind: "import", targetPath: "/home/dev/.codex/trunc", valid: false },
    ]);
  });
});

const HOME = { homeDir: "/home/dev" };

function instructionFile(content: string | undefined): AdapterSourceFile {
  return {
    content,
    exists: true,
    spec: {
      id: "codex.instructions.global",
      kind: "instructions",
      path: "/home/dev/.codex/AGENTS.md",
      scope: "global",
    },
  };
}
