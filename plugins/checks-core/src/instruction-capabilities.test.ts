import claudeCodePlugin from "@tryaura/adapter-claude-code";
import codexPlugin from "@tryaura/adapter-codex";
import cursorPlugin from "@tryaura/adapter-cursor";
import type { AuraPlugin } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { instructionCapabilities } from "./instruction-capabilities.js";

function declaredBy(plugin: AuraPlugin) {
  const adapter = (plugin.adapters ?? [])[0];
  return { capabilities: adapter?.capabilities };
}

describe("instruction capabilities", () => {
  it("resolves what the bundled adapters declare", () => {
    expect(instructionCapabilities(declaredBy(claudeCodePlugin))).toEqual({
      importDepthLimit: 5,
      importStyle: "at-import",
      loading: "import-graph",
    });
    expect(instructionCapabilities(declaredBy(codexPlugin))).toEqual({
      importDepthLimit: undefined,
      importStyle: "none",
      loading: "all-files",
    });
    expect(instructionCapabilities(declaredBy(cursorPlugin))).toEqual({
      importDepthLimit: undefined,
      importStyle: "at-import",
      loading: "import-graph",
    });
  });

  it("gives an app whose adapter declares nothing the SDK's documented fallbacks", () => {
    expect(instructionCapabilities({ capabilities: undefined })).toEqual({
      importDepthLimit: undefined,
      importStyle: "at-import",
      loading: undefined,
    });
  });
});
