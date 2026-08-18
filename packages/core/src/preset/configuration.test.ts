import { defineCheck, type AuraConfigurationLayer, type SkillSourceId } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { enabledChecks, resolveEffectiveConfig } from "./configuration.js";

const check = defineCheck({
  defaultSeverity: "info",
  detect: () => [],
  explain: "Fixture.",
  fixability: "manual",
  id: "INS-007",
  scope: "global",
  title: "Fixture",
});

describe("resolveEffectiveConfig", () => {
  it("resolves distro, preset, manifest, and CLI values with provenance", () => {
    const distro: AuraConfigurationLayer = {
      checks: { disabled: ["INS-007"], severity: { "INS-007": "warn" } },
    };
    const preset: AuraConfigurationLayer = {
      checks: { enabled: ["INS-007"], severity: { "INS-007": "error" } },
    };
    const manifest: AuraConfigurationLayer = {
      checks: { thresholds: { "INS-007": { approxTokens: 12_000 } } },
    };
    const cli: AuraConfigurationLayer = {
      checks: { severity: { "INS-007": "info" } },
    };

    const result = resolveEffectiveConfig({
      checks: [check],
      cli,
      distro,
      manifest,
      preset,
      selectedPreset: { name: "Acme", reference: "plugin:acme/platform" },
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      return;
    }
    expect(result.config.checks["INS-007"]).toEqual({
      enabled: { provenance: { label: "Acme", layer: "preset" }, value: true },
      severity: { provenance: { label: "command line", layer: "cli" }, value: "info" },
      thresholds: {
        provenance: { label: "user manifest", layer: "manifest" },
        value: { approxTokens: 12_000 },
      },
    });
    expect(enabledChecks([check], result.config)).toEqual([check]);
  });

  it("fails closed for unknown checks and required MCP catalog ids", () => {
    const result = resolveEffectiveConfig({
      checks: [check],
      knownMcpServers: new Set(["official/github"]),
      preset: {
        checks: { disabled: ["MISSING-001"] },
        requiredMcpServers: ["missing/server"],
      },
    });

    expect(result).toMatchObject({ status: "invalid" });
    if (result.status === "invalid") {
      expect(result.problems.join("\n")).toContain("Unknown check ID MISSING-001");
      expect(result.problems.join("\n")).toContain("Unknown required MCP server missing/server");
    }
  });

  it("copies and deeply freezes values supplied by mutable distribution defaults", () => {
    const thresholds = { nested: { values: [1, 2] } };
    const sources: readonly SkillSourceId[] = ["plugin:official"];
    const result = resolveEffectiveConfig({
      checks: [check],
      distro: {
        allowedSkillSources: sources,
        checks: { thresholds: { "INS-007": thresholds } },
      },
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      return;
    }
    expect(Object.isFrozen(result.config)).toBe(true);
    expect(Object.isFrozen(result.config.allowedSkillSources?.value)).toBe(true);
    expect(Object.isFrozen(result.config.checks["INS-007"]?.thresholds.value)).toBe(true);
    expect(result.config.checks["INS-007"]?.thresholds.value).not.toBe(thresholds);
    expect(Object.isFrozen(result.config.checks["INS-007"]?.thresholds.value["nested"])).toBe(true);
  });

  it("keeps requirements additive while manifest content selections supersede preset defaults", () => {
    const result = resolveEffectiveConfig({
      checks: [check],
      distro: {
        requiredMcpServers: ["official/docs"],
        skillDirectories: [
          { id: "directory:base", kind: "directory", name: "Base", url: "https://base.test" },
        ],
      },
      knownMcpServers: new Set(["official/docs", "official/github"]),
      manifest: {
        skills: [{ id: "local", source: "plugin:official" }],
        snippets: [],
      },
      preset: {
        allowedSkillSources: ["plugin:official"],
        requiredMcpServers: ["official/github"],
        skillDirectories: [
          { id: "directory:team", kind: "directory", name: "Team", url: "https://team.test" },
        ],
        skills: [{ id: "review", source: "plugin:official" }],
        snippets: ["official/engineering"],
      },
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      return;
    }
    expect(result.config.requiredMcpServers).toMatchObject([
      { provenance: { layer: "distro" }, value: "official/docs" },
      { provenance: { layer: "preset" }, value: "official/github" },
    ]);
    expect(result.config.skillDirectories.map(({ value }) => value.id)).toEqual([
      "directory:base",
      "directory:team",
    ]);
    expect(result.config.skills).toMatchObject([
      { provenance: { layer: "manifest" }, value: { id: "local" } },
    ]);
    expect(result.config.snippets).toEqual([]);
    expect(result.config.allowedSkillSources).toMatchObject({
      provenance: { layer: "preset" },
      value: ["plugin:official"],
    });
  });
});
