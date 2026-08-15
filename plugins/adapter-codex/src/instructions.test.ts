import type { AdapterSourceFile } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { parseInstructionFile } from "./instructions.js";

describe("Codex native instructions", () => {
  it("preserves content and points at the shared Aura instructions", () => {
    expect(parseInstructionFile(instructionFile("# Personal rules\n"), "/home/dev")).toEqual({
      content: "# Personal rules\n",
      links: [{ kind: "native", targetPath: "/home/dev/agents/AGENTS.md", valid: false }],
      path: "/home/dev/.codex/AGENTS.md",
      scope: "global",
      sourceId: "codex.instructions.global",
    });
  });

  it("handles empty content without inventing instructions", () => {
    expect(parseInstructionFile(instructionFile(undefined), "/home/dev").content).toBe("");
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
