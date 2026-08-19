import type { AdapterSourceFile } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { parseProjectTrust } from "./trust.js";

describe("Codex project trust", () => {
  it("uses the primary checkout trust entry from a linked worktree", () => {
    const config = sourceFile('[projects."/repos/main"]\ntrust_level = "trusted"\n');

    expect(
      parseProjectTrust(config, {
        cwd: "/worktrees/feature",
        gitMainWorktreeRoot: "/repos/main",
      }),
    ).toBe("trusted");
  });
});

function sourceFile(content: string): AdapterSourceFile {
  return {
    content,
    exists: true,
    pathKind: "file",
    spec: {
      id: "codex.mcp.global",
      kind: "mcp",
      path: "/home/dev/.codex/config.toml",
      scope: "global",
    },
  };
}
