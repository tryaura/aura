import type { Environment, WorkspaceModel } from "@tryaura/aura-sdk";
import {
  createFileReader,
  readTeamPreset,
  type PluginRegistry,
  type TeamPresetState,
} from "@tryaura/core";

import { createMcpSetupCatalog, type McpSetupCatalog } from "./mcp-catalog.js";
import { createSkillCatalog, type SkillCatalog } from "./skills-catalog.js";
import type { SetupStep } from "./types.js";

/** Everything the run's steps choose from, or the preset problem that stops the run. */
export type SetupCatalogs =
  | {
      readonly kind: "ready";
      readonly mcpCatalog: McpSetupCatalog;
      readonly skillCatalog: SkillCatalog;
    }
  | { readonly kind: "invalid-preset"; readonly messages: readonly string[] };

interface SetupCatalogInputs {
  readonly environment: Environment;
  readonly model: WorkspaceModel;
  readonly registry: PluginRegistry;
  readonly steps: readonly SetupStep[];
}

/**
 * Reads the team preset once and builds the catalogs that depend on it.
 *
 * An unreadable preset only stops a run whose steps would have obeyed it: skills reads its
 * allowed sources, MCP its required servers. Every other step is unaffected by a file it never
 * consults, and failing those runs would make one malformed repository file the reason setup
 * cannot touch a machine at all.
 */
export async function createSetupCatalogs(inputs: SetupCatalogInputs): Promise<SetupCatalogs> {
  const preset: TeamPresetState = await readTeamPreset(inputs.environment.cwd, createFileReader());
  const messages = preset.diagnostics.map((diagnostic) => diagnostic.message);
  if (
    preset.status === "invalid" &&
    inputs.steps.some((step) => step.id === "skills" || step.id === "mcp")
  ) {
    return { kind: "invalid-preset", messages };
  }
  return {
    kind: "ready",
    mcpCatalog: createMcpSetupCatalog({
      model: inputs.model,
      preset: preset.preset,
      registry: inputs.registry,
    }),
    skillCatalog: createSkillCatalog({
      environment: inputs.environment,
      model: inputs.model,
      preset: preset.preset,
      presetNotes: messages,
      registryDirectories: inputs.registry.skillDirectories,
    }),
  };
}
