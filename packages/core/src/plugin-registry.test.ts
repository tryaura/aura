import { describe, expect, it } from "vitest";

import {
  createPluginRegistry,
  type PluginRegistry,
  SUPPORTED_PLUGIN_API_VERSION,
} from "./index.js";
import {
  captureRegistryError,
  createAdapter,
  createCheck,
  createMcpServer,
  createPlugin,
  createPreset,
  createPrivateSkillDirectory,
  createSkill,
  createSkillDirectory,
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
    const alphaSkill = createSkill("review");
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
    expect(registry.skills).toEqual([
      {
        skill: alphaSkill,
        source: { id: "plugin:alpha", kind: "bundled", name: "alpha" },
      },
    ]);
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
      skills: [createSkill("review")],
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
    expect(registry.ownerOf("skill-pack", "plugin:alpha/review")).toBe(alpha);
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
  it("accepts semver versions with prerelease and build metadata", () => {
    expect(() =>
      captureRegistryError([createPlugin("acme", { name: "Acme", version: "1.2.3-rc.1+build.5" })]),
    ).toThrow("Expected plugin registry creation to fail.");
  });

  it("rejects versions that only become semver after normalization", () => {
    // A version is an identity field carried around as declared, so "parses as semver" is not
    // enough: `semver` also accepts a leading `v` and surrounding whitespace, and storing either
    // raw would let two spellings of one version travel under different names.
    for (const version of ["v1.0.0", " 1.0.0 ", "1.0.0\n", "\t1.2.3"]) {
      const error = captureRegistryError([createPlugin("acme", { name: "Acme", version })]);

      expect(error.message).toContain(`declares version "${version}"`);
      expect(error.message).toContain("expected a semver version");
    }
  });

  it("rejects adapter IDs that cannot be used in paths, reports, and lookups", () => {
    const emptyError = captureRegistryError([
      createPlugin("acme", { adapters: [createAdapter("")], name: "Acme" }),
    ]);
    const slashError = captureRegistryError([
      createPlugin("acme", { adapters: [createAdapter("agents/one")], name: "Acme" }),
    ]);

    expect(emptyError.message).toContain('contributes adapter ID ""');
    expect(slashError.message).toContain('contributes adapter ID "agents/one"');
    expect(slashError.message).toContain("expected lowercase letters, digits");
  });

  it.each(["Review", "review_skill", "review/skill", "-review", `${"a".repeat(65)}`])(
    "rejects invalid source-local skill ID %s",
    (id) => {
      const error = captureRegistryError([createPlugin("alpha", { skills: [createSkill(id)] })]);

      expect(error.message).toContain(`skill-pack ID "${id}"`);
      expect(error.message).toContain("kebab-case local skill ID");
    },
  );

  // Managed content is held at its recorded revision until a newer one is reviewed, and "newer" is
  // a semver comparison. A version semver cannot order has no upgrade path at all, so it would sit
  // frozen forever with neither setup nor MGD-002 ever naming it.
  it.each(["2024-05", "v1.0.0", "1.0", "latest"])(
    "rejects a snippet version it could never compare: %s",
    (version) => {
      const error = captureRegistryError([
        createPlugin("alpha", { snippets: [{ ...createSnippet("alpha/rules"), version }] }),
      ]);

      expect(error.message).toContain(`snippet "alpha/rules" declares version "${version}"`);
      expect(error.message).toContain("held at its recorded revision");
    },
  );

  it("rejects a skill version it could never compare", () => {
    const error = captureRegistryError([
      createPlugin("alpha", { skills: [{ ...createSkill("review"), version: "2024-05" }] }),
    ]);

    expect(error.message).toContain('skill "review" declares version "2024-05"');
  });

  it("accepts a canonical prerelease and build-metadata version", () => {
    const registry = createPluginRegistry([
      createPlugin("alpha", {
        snippets: [{ ...createSnippet("alpha/rules"), version: "1.2.3-rc.1+build.5" }],
      }),
    ]);

    expect(registry.snippets[0]?.version).toBe("1.2.3-rc.1+build.5");
  });

  it("rejects duplicate local IDs within one bundled source", () => {
    const error = captureRegistryError([
      createPlugin("alpha", { skills: [createSkill("review"), createSkill("review")] }),
    ]);

    expect(error.message).toContain('duplicate skill-pack ID "plugin:alpha/review"');
  });

  it("registers plugin skill directories under their global ids", () => {
    const official = createSkillDirectory("agenticskills");
    const acme = createPrivateSkillDirectory("acme");
    const alpha = createPlugin("alpha", { skillDirectories: [official, acme] });

    const registry = createPluginRegistry([alpha]);

    expect(registry.skillDirectories).toEqual([official, acme]);
    expect(registry.ownerOf("skill-directory", "directory:agenticskills")).toBe(alpha);
  });

  it("rejects two plugins claiming the same skill directory id", () => {
    const error = captureRegistryError([
      createPlugin("alpha", { skillDirectories: [createSkillDirectory("agenticskills")] }),
      createPlugin("beta", { skillDirectories: [createSkillDirectory("agenticskills")] }),
    ]);

    expect(error.message).toContain('duplicate skill-directory ID "directory:agenticskills"');
  });

  it("rejects malformed skill directory ids, URLs, and token variable names", () => {
    const idError = captureRegistryError([
      createPlugin("alpha", { skillDirectories: [createSkillDirectory("Bad-Name")] }),
    ]);
    const urlError = captureRegistryError([
      createPlugin("alpha", {
        skillDirectories: [createSkillDirectory("acme", { url: "http://acme.example" })],
      }),
    ]);
    const tokenError = captureRegistryError([
      createPlugin("alpha", {
        skillDirectories: [createPrivateSkillDirectory("acme", { tokenEnv: "acme-token" })],
      }),
    ]);

    expect(idError.message).toContain('expected "directory:" followed by a kebab-case name');
    expect(urlError.message).toContain("expected https (plain http is loopback-only)");
    expect(tokenError.message).toContain("a name, never a value");
  });

  it("allows the same local ID in different bundled sources", () => {
    const registry = createPluginRegistry([
      createPlugin("alpha", { skills: [createSkill("review")] }),
      createPlugin("beta", { skills: [createSkill("review")] }),
    ]);

    expect(registry.skills.map(({ source, skill }) => [source.id, skill.id])).toEqual([
      ["plugin:alpha", "review"],
      ["plugin:beta", "review"],
    ]);
  });
});
