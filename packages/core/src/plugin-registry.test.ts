import { describe, expect, it } from "vitest";

import {
  createPluginRegistry,
  type PluginRegistry,
  SUPPORTED_PLUGIN_API_VERSION,
} from "./index.js";
import {
  createAdapter,
  createCheck,
  createMcpServer,
  createPlugin,
  createPreset,
  createSkill,
  createSkillSource,
  createSnippet,
} from "./plugin-fixtures.js";

describe("createPluginRegistry", () => {
  it("validates and flattens every contribution kind in declaration order", () => {
    const alphaAdapter = createAdapter("alpha-agent");
    const coreAdapter = createAdapter("core-agent");
    const alphaCheck = createCheck("alpha/SEC-001");
    const coreCheck = createCheck("INS-001");
    const alphaSnippet = createSnippet("alpha/rules");
    const alphaSkill = createSkill("alpha/review");
    const alphaSkillSource = createSkillSource("alpha/registry");
    const alphaMcpServer = createMcpServer("alpha/search");
    const alphaPreset = createPreset("alpha/starter");
    const alpha = createPlugin("alpha", {
      adapters: [alphaAdapter],
      checks: [alphaCheck],
      mcpCatalog: [alphaMcpServer],
      presets: [alphaPreset],
      skills: [alphaSkill],
      skillSources: [alphaSkillSource],
      snippets: [alphaSnippet],
    });
    const empty = createPlugin("empty");
    const core = createPlugin("core", {
      adapters: [coreAdapter],
      checks: [coreCheck],
    });

    const registry: PluginRegistry = createPluginRegistry([alpha, empty, core], {
      bareCheckIdPlugins: ["core"],
    });

    expect(SUPPORTED_PLUGIN_API_VERSION).toBe(1);
    expect(registry.plugins).toEqual([alpha, empty, core]);
    expect(registry.adapters).toEqual([alphaAdapter, coreAdapter]);
    expect(registry.checks).toEqual([alphaCheck, coreCheck]);
    expect(registry.snippets).toEqual([alphaSnippet]);
    expect(registry.skills).toEqual([alphaSkill]);
    expect(registry.skillSources).toEqual([alphaSkillSource]);
    expect(registry.mcpServers).toEqual([alphaMcpServer]);
    expect(registry.presets).toEqual([alphaPreset]);
  });

  it("resolves the contributing plugin for every registered ID", () => {
    const alpha = createPlugin("alpha", {
      adapters: [createAdapter("alpha-agent")],
      checks: [createCheck("alpha/SEC-001")],
      mcpCatalog: [createMcpServer("alpha/search")],
      presets: [createPreset("alpha/starter")],
      skills: [createSkill("alpha/review")],
      skillSources: [createSkillSource("alpha/registry")],
      snippets: [createSnippet("alpha/rules")],
    });
    const core = createPlugin("core", { checks: [createCheck("INS-001")] });

    const registry = createPluginRegistry([alpha, core], { bareCheckIdPlugins: ["core"] });

    expect(registry.ownerOf("plugin", "alpha")).toBe(alpha);
    expect(registry.ownerOf("adapter", "alpha-agent")).toBe(alpha);
    expect(registry.ownerOf("check", "alpha/SEC-001")).toBe(alpha);
    expect(registry.ownerOf("mcp-server", "alpha/search")).toBe(alpha);
    expect(registry.ownerOf("preset", "alpha/starter")).toBe(alpha);
    expect(registry.ownerOf("skill-pack", "alpha/review")).toBe(alpha);
    expect(registry.ownerOf("skill-source", "alpha/registry")).toBe(alpha);
    expect(registry.ownerOf("snippet", "alpha/rules")).toBe(alpha);
    // A bare check id carries no namespace, so ownership cannot be recovered from the id alone.
    expect(registry.ownerOf("check", "INS-001")).toBe(core);
    expect(registry.ownerOf("check", "alpha/UNKNOWN")).toBeUndefined();
    expect(registry.ownerOf("adapter", "alpha/SEC-001")).toBeUndefined();
  });

  it("freezes the registry and its contribution lists", () => {
    const registry = createPluginRegistry([
      createPlugin("alpha", { checks: [createCheck("alpha/SEC-001")] }),
    ]);

    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.adapters)).toBe(true);
    expect(Object.isFrozen(registry.checks)).toBe(true);
    expect(Object.isFrozen(registry.mcpServers)).toBe(true);
    expect(Object.isFrozen(registry.plugins)).toBe(true);
    expect(Object.isFrozen(registry.presets)).toBe(true);
    expect(Object.isFrozen(registry.skills)).toBe(true);
    expect(Object.isFrozen(registry.skillSources)).toBe(true);
    expect(Object.isFrozen(registry.snippets)).toBe(true);
  });
});
