import type { AdapterSourceFile } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { parseInstructionFile } from "./instructions.js";

describe("Codex native instructions", () => {
  it("preserves a real file without claiming it links to shared instructions", () => {
    expect(parseInstructionFile(instructionFile("# Personal rules\n"))).toEqual({
      content: "# Personal rules\n",
      links: [],
      path: "/home/dev/.codex/AGENTS.md",
      scope: "global",
      sourceId: "codex.instructions.global",
    });
  });

  it("reports the raw target of a symbolic link", () => {
    expect(
      parseInstructionFile({
        ...instructionFile("# Shared\n"),
        pathKind: "symlink",
        symlinkTarget: "../agents/AGENTS.md",
      }).links,
    ).toEqual([{ kind: "symlink", targetPath: "/home/dev/agents/AGENTS.md", valid: false }]);
  });

  it("handles empty content without inventing instructions", () => {
    expect(parseInstructionFile(instructionFile(undefined)).content).toBe("");
  });
});

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
