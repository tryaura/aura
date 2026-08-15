import type { Adapter, Check, SkillPack, Snippet } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import {
  createPluginRegistry,
  type PluginCandidate,
  type PluginRegistry,
  type PluginRegistryOptions,
  SUPPORTED_PLUGIN_API_VERSION,
} from "./index.js";

interface PluginFixtureOptions {
  readonly adapters?: readonly Adapter[] | undefined;
  readonly apiVersion?: number | undefined;
  readonly checks?: readonly Check[] | undefined;
  readonly name?: string | undefined;
  readonly skills?: readonly SkillPack[] | undefined;
  readonly snippets?: readonly Snippet[] | undefined;
}

interface CollisionCase {
  readonly candidates: readonly PluginCandidate[];
  readonly id: string;
  readonly kind: string;
  readonly options?: PluginRegistryOptions | undefined;
  readonly originalPlugin: string;
  readonly offendingPlugin: string;
}

describe("createPluginRegistry", () => {
  it("validates and flattens contributions in declaration order", () => {
    const alphaAdapter = createAdapter("alpha-agent");
    const coreAdapter = createAdapter("core-agent");
    const alphaCheck = createCheck("alpha/SEC-001");
    const coreCheck = createCheck("INS-001");
    const alphaSnippet = createSnippet("alpha/rules");
    const alphaSkill = createSkill("alpha/review");
    const alpha = createPlugin("alpha", {
      adapters: [alphaAdapter],
      checks: [alphaCheck],
      skills: [alphaSkill],
      snippets: [alphaSnippet],
    });
    const empty = createPlugin("empty");
    const core = createPlugin("core", {
      adapters: [coreAdapter],
      checks: [coreCheck],
    });

    const registry: PluginRegistry = createPluginRegistry([alpha, empty, core], {
      officialPluginIds: ["core"],
    });

    expect(SUPPORTED_PLUGIN_API_VERSION).toBe(1);
    expect(registry.plugins).toEqual([alpha, empty, core]);
    expect(registry.adapters).toEqual([alphaAdapter, coreAdapter]);
    expect(registry.checks).toEqual([alphaCheck, coreCheck]);
    expect(registry.snippets).toEqual([alphaSnippet]);
    expect(registry.skills).toEqual([alphaSkill]);
  });

  it("rejects an unsupported API version", () => {
    const error = captureRegistryError([
      createPlugin("future", { apiVersion: 2, name: "Future Plugin" }),
    ]);

    expect(error.message).toContain('Plugin "Future Plugin" (future)');
    expect(error.message).toContain("unsupported apiVersion 2");
    expect(error.message).toContain("supports apiVersion 1");
  });

  it("rejects duplicate plugin IDs and identifies both plugins", () => {
    const error = captureRegistryError([
      createPlugin("shared", { name: "Original Plugin" }),
      createPlugin("shared", { name: "Offending Plugin" }),
    ]);

    expect(error.message).toContain('Plugin "Offending Plugin" (shared)');
    expect(error.message).toContain('duplicate plugin ID "shared"');
    expect(error.message).toContain('Plugin "Original Plugin" (shared)');
  });

  it("rejects duplicate contribution IDs within or across plugins", () => {
    const cases: readonly CollisionCase[] = [
      {
        candidates: [
          createPlugin("alpha", {
            adapters: [createAdapter("shared-agent"), createAdapter("shared-agent")],
            name: "Alpha Plugin",
          }),
        ],
        id: "shared-agent",
        kind: "adapter",
        offendingPlugin: "Alpha Plugin",
        originalPlugin: "Alpha Plugin",
      },
      {
        candidates: [
          createPlugin("alpha", {
            adapters: [createAdapter("shared-agent")],
            name: "Alpha Plugin",
          }),
          createPlugin("beta", {
            adapters: [createAdapter("shared-agent")],
            name: "Beta Plugin",
          }),
        ],
        id: "shared-agent",
        kind: "adapter",
        offendingPlugin: "Beta Plugin",
        originalPlugin: "Alpha Plugin",
      },
      {
        candidates: [
          createPlugin("alpha", {
            checks: [createCheck("alpha/SEC-001"), createCheck("alpha/SEC-001")],
            name: "Alpha Plugin",
          }),
        ],
        id: "alpha/SEC-001",
        kind: "check",
        offendingPlugin: "Alpha Plugin",
        originalPlugin: "Alpha Plugin",
      },
      {
        candidates: [
          createPlugin("official-one", {
            checks: [createCheck("INS-001")],
            name: "Official One",
          }),
          createPlugin("official-two", {
            checks: [createCheck("INS-001")],
            name: "Official Two",
          }),
        ],
        id: "INS-001",
        kind: "check",
        offendingPlugin: "Official Two",
        options: { officialPluginIds: ["official-one", "official-two"] },
        originalPlugin: "Official One",
      },
      {
        candidates: [
          createPlugin("alpha", {
            name: "Alpha Plugin",
            snippets: [createSnippet("alpha/rules"), createSnippet("alpha/rules")],
          }),
        ],
        id: "alpha/rules",
        kind: "snippet",
        offendingPlugin: "Alpha Plugin",
        originalPlugin: "Alpha Plugin",
      },
      {
        candidates: [
          createPlugin("alpha", {
            name: "Alpha Plugin",
            skills: [createSkill("alpha/review"), createSkill("alpha/review")],
          }),
        ],
        id: "alpha/review",
        kind: "skill",
        offendingPlugin: "Alpha Plugin",
        originalPlugin: "Alpha Plugin",
      },
    ];

    for (const collision of cases) {
      const error = captureRegistryError(collision.candidates, collision.options);

      expect(error.message).toContain(`Plugin "${collision.offendingPlugin}"`);
      expect(error.message).toContain(`duplicate ${collision.kind} ID "${collision.id}"`);
      expect(error.message).toContain(`Plugin "${collision.originalPlugin}"`);
    }
  });

  it("rejects check IDs outside the owning namespace", () => {
    const bareError = captureRegistryError([
      createPlugin("acme", { checks: [createCheck("SEC-001")], name: "Acme" }),
    ]);
    const wrongNamespaceError = captureRegistryError(
      [createPlugin("core", { checks: [createCheck("other/INS-001")], name: "Core" })],
      { officialPluginIds: ["core"] },
    );

    expect(bareError.message).toContain('Plugin "Acme" (acme)');
    expect(bareError.message).toContain('check ID "SEC-001"');
    expect(bareError.message).toContain('"acme/<id>" namespace');
    expect(wrongNamespaceError.message).toContain('check ID "other/INS-001"');
    expect(wrongNamespaceError.message).toContain('"core/<id>" namespace');
  });

  it("rejects snippet and skill IDs outside the owning namespace", () => {
    const snippetError = captureRegistryError([
      createPlugin("acme", { name: "Acme", snippets: [createSnippet("rules")] }),
    ]);
    const skillError = captureRegistryError([
      createPlugin("acme", { name: "Acme", skills: [createSkill("other/review")] }),
    ]);

    expect(snippetError.message).toContain('Plugin "Acme" (acme)');
    expect(snippetError.message).toContain('snippet ID "rules"');
    expect(snippetError.message).toContain('"acme/<id>" namespace');
    expect(skillError.message).toContain('skill ID "other/review"');
    expect(skillError.message).toContain('"acme/<id>" namespace');
  });
});

function createPlugin(id: string, options: PluginFixtureOptions = {}): PluginCandidate {
  return {
    adapters: options.adapters,
    apiVersion: options.apiVersion ?? 1,
    checks: options.checks,
    id,
    name: options.name ?? id,
    skills: options.skills,
    snippets: options.snippets,
    version: "1.0.0",
  };
}

function createAdapter(id: string): Adapter {
  return {
    async detect() {
      return { installed: false };
    },
    displayName: id,
    files() {
      return [];
    },
    id,
    parse() {
      return { instructionFiles: [], mcpServers: [], skills: [] };
    },
    supportedRange: ">=1 <2",
  };
}

function createCheck(id: string): Check {
  return {
    defaultSeverity: "warn",
    detect() {
      return [];
    },
    explain: "Fixture check.",
    fixability: "manual",
    id,
    scope: "global",
    title: "Fixture check",
  };
}

function createSnippet(id: string): Snippet {
  return {
    description: "Fixture snippet.",
    id,
    kind: "snippet",
    name: id,
    source: { type: "file", url: "file:///fixture/snippet.md" },
    version: "1.0.0",
  };
}

function createSkill(id: string): SkillPack {
  return {
    description: "Fixture skill.",
    id,
    kind: "skill-pack",
    name: id,
    source: { type: "directory", url: "file:///fixture/skill/" },
    version: "1.0.0",
  };
}

function captureRegistryError(
  candidates: readonly PluginCandidate[],
  options?: PluginRegistryOptions,
): Error {
  try {
    createPluginRegistry(candidates, options);
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }

    throw error;
  }

  throw new Error("Expected plugin registry creation to fail.");
}
