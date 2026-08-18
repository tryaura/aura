import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";
import type { AuraManifestMcpServer, WorkspaceModel } from "@tryaura/aura-sdk";
import { createEmptyAuraManifest } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { planSetupMcp } from "./mcp-planner.js";
import { emptySkillCatalog, emptySnippetCatalog } from "./testing.js";
import type { SetupStepContext } from "./types.js";

describe("MCP setup planner", () => {
  it("blocks when a preset-required catalog id did not resolve", () => {
    const manifest: Extract<WorkspaceModel["manifest"], { readonly status: "ready" }> = {
      exists: true,
      path: "/home/dev/agents/aura.json",
      status: "ready",
      value: createEmptyAuraManifest(),
    };
    const model = createWorkspaceModel({
      manifest,
      projectRoot: "/workspace",
      sharedInstructions: { exists: false, path: "/home/dev/agents/AGENTS.md" },
    });
    const context: SetupStepContext = {
      appCatalog: [],
      interactive: false,
      isEnvironmentVariableSet: () => false,
      manifest,
      mcpCatalog: {
        entries: [],
        missingRequiredIds: ["official/missing"],
        requiredIds: new Set(["official/missing"]),
      },
      model,
      selections: { mcp: { servers: [] } },
      skillCatalog: emptySkillCatalog(),
      snippetCatalog: emptySnippetCatalog(),
    };

    expect(planSetupMcp(context, manifest.value).blockers).toEqual([
      {
        path: "/workspace/.aura/preset.json",
        reason:
          "Required MCP catalog entry official/missing is not available from the installed plugins.",
      },
    ]);
  });

  it("blocks an available required server that could not target a compatible app", () => {
    const context = setupContext({
      interactive: true,
      requiredIds: new Set(["official/github"]),
      servers: [],
    });

    expect(planSetupMcp(context, createEmptyAuraManifest()).blockers).toEqual([
      {
        path: "/workspace/.aura/preset.json",
        reason:
          "Required MCP catalog entry official/github could not be selected for a managed compatible application.",
      },
    ]);
  });

  it("names the interactive run a non-interactive one has to defer to", () => {
    const context = setupContext({
      requiredIds: new Set(["official/github"]),
      servers: [],
    });

    expect(planSetupMcp(context, createEmptyAuraManifest()).blockers[0]?.reason).toContain(
      "Run setup interactively",
    );
  });

  it("honors an explicit run-local override for an available required server", () => {
    const context = setupContext({
      overriddenRequiredIds: ["official/github"],
      requiredIds: new Set(["official/github"]),
      servers: [],
    });

    expect(planSetupMcp(context, createEmptyAuraManifest()).blockers).toEqual([]);
  });
});

interface SetupContextOptions {
  readonly interactive?: boolean | undefined;
  readonly overriddenRequiredIds?: readonly string[] | undefined;
  readonly requiredIds: ReadonlySet<string>;
  readonly servers: readonly AuraManifestMcpServer[];
}

function setupContext(options: SetupContextOptions): SetupStepContext {
  const manifest: Extract<WorkspaceModel["manifest"], { readonly status: "ready" }> = {
    exists: true,
    path: "/home/dev/agents/aura.json",
    status: "ready",
    value: createEmptyAuraManifest(),
  };
  const model = createWorkspaceModel({
    manifest,
    projectRoot: "/workspace",
    sharedInstructions: { exists: false, path: "/home/dev/agents/AGENTS.md" },
  });
  return {
    appCatalog: [],
    interactive: options.interactive ?? false,
    isEnvironmentVariableSet: () => false,
    manifest,
    mcpCatalog: {
      entries: [],
      missingRequiredIds: [],
      requiredIds: options.requiredIds,
    },
    model,
    selections: {
      mcp: {
        overriddenRequiredIds: options.overriddenRequiredIds,
        servers: options.servers,
      },
    },
    skillCatalog: emptySkillCatalog(),
    snippetCatalog: emptySnippetCatalog(),
  };
}
