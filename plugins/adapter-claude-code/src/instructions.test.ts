import type { AdapterSourceFile } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { parseInstructionFile } from "./instructions.js";

const HOME_DIR = "/home/dev";

describe("Claude Code instruction imports", () => {
  it("resolves relative, home-relative, and absolute imports", () => {
    const document = parse([
      "@team.md",
      "See @docs/workflow.md for details.",
      "- @~/agents/AGENTS.md",
      "> @/opt/company/rules.md",
      "@~/notes",
    ]);

    expect(document.links).toEqual([
      { kind: "import", targetPath: "/home/dev/.claude/team.md", valid: false },
      { kind: "import", targetPath: "/home/dev/.claude/docs/workflow.md", valid: false },
      { kind: "import", targetPath: "/home/dev/agents/AGENTS.md", valid: false },
      { kind: "import", targetPath: "/opt/company/rules.md", valid: false },
      { kind: "import", targetPath: "/home/dev/notes", valid: false },
    ]);
  });

  it("ignores imports in inline code and fenced code blocks", () => {
    const document = parse([
      "Keep `@literal.md` literal.",
      "```md",
      "@fenced.md",
      "```",
      "~~~",
      "@also-fenced.md",
      "~~~",
      "Load @real.md.",
    ]);

    expect(document.links).toEqual([
      { kind: "import", targetPath: "/home/dev/.claude/real.md", valid: false },
    ]);
  });

  it("ignores mentions and package names that are not file references", () => {
    const document = parse([
      "Ping @alice when the build breaks.",
      "We depend on @tryaura/core and @anthropic-ai/sdk.",
      "Email dev@example.com for access.",
      "Costs rise @ 100 requests.",
      "Load @real.md.",
    ]);

    expect(document.links).toEqual([
      { kind: "import", targetPath: "/home/dev/.claude/real.md", valid: false },
    ]);
  });
});

function parse(lines: readonly string[]): ReturnType<typeof parseInstructionFile> {
  return parseInstructionFile(instructionFile(lines.join("\n")), HOME_DIR);
}

function instructionFile(content: string): AdapterSourceFile {
  return {
    content,
    entries: undefined,
    exists: true,
    problem: undefined,
    spec: {
      id: "claude-code.instructions.global",
      kind: "instructions",
      path: "/home/dev/.claude/CLAUDE.md",
      scope: "global",
    },
  };
}
