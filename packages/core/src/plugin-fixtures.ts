import type {
  Adapter,
  Check,
  McpServerDef,
  Preset,
  SkillListing,
  SkillPack,
  SkillSourceDriver,
  Snippet,
} from "@tryaura/aura-sdk";

import { createPluginRegistry, type PluginCandidate, type PluginRegistryOptions } from "./index.js";

/** Contribution fixtures shared by the registry and validation suites. Excluded from the build. */
export interface PluginFixtureOptions {
  readonly adapters?: readonly Adapter[] | undefined;
  readonly apiVersion?: number | undefined;
  readonly checks?: readonly Check[] | undefined;
  readonly mcpCatalog?: readonly McpServerDef[] | undefined;
  readonly name?: string | undefined;
  readonly presets?: readonly Preset[] | undefined;
  readonly skills?: readonly SkillPack[] | undefined;
  readonly skillSources?: readonly SkillSourceDriver[] | undefined;
  readonly snippets?: readonly Snippet[] | undefined;
  readonly version?: string | undefined;
}

export function createPlugin(id: string, options: PluginFixtureOptions = {}): PluginCandidate {
  return {
    adapters: options.adapters,
    apiVersion: options.apiVersion ?? 1,
    checks: options.checks,
    id,
    mcpCatalog: options.mcpCatalog,
    name: options.name ?? id,
    presets: options.presets,
    skills: options.skills,
    skillSources: options.skillSources,
    snippets: options.snippets,
    version: options.version ?? "1.0.0",
  };
}

export function createAdapter(id: string): Adapter {
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

export function createCheck(id: string): Check {
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

export function createSnippet(id: string): Snippet {
  return {
    description: "Fixture snippet.",
    id,
    kind: "snippet",
    name: id,
    source: { type: "file", url: "file:///fixture/snippet.md" },
    version: "1.0.0",
  };
}

export function createSkill(id: string): SkillPack {
  return {
    description: "Fixture skill.",
    id,
    kind: "skill-pack",
    name: id,
    source: { type: "directory", url: "file:///fixture/skill/" },
    version: "1.0.0",
  };
}

export function createMcpServer(id: string): McpServerDef {
  return {
    description: "Fixture MCP server.",
    id,
    kind: "mcp-server",
    name: id,
    source: { type: "file", url: "file:///fixture/mcp.json" },
    version: "1.0.0",
  };
}

export function createPreset(id: string): Preset {
  return {
    description: "Fixture preset.",
    id,
    kind: "preset",
    name: id,
    source: { type: "file", url: "file:///fixture/preset.json" },
    version: "1.0.0",
  };
}

export function createSkillSource(id: string): SkillSourceDriver {
  return {
    description: "Fixture skill source.",
    id,
    async list(): Promise<readonly SkillListing[]> {
      return [];
    },
    name: id,
    async resolve(): Promise<ReadonlyMap<string, SkillPack>> {
      return new Map();
    },
  };
}

/** Runs the registry expecting failure, and returns the error so a suite can assert on it. */
export function captureRegistryError(
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
