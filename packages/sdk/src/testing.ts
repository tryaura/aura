/**
 * Fixture builders for testing plugins against the SDK's own types.
 *
 * Kept out of the main entry point: nothing here belongs in a shipped command, and a plugin that
 * imports it by accident should notice from the specifier.
 */

import type { WorkspaceModel } from "./workspace-model.js";

/** Everything a {@link WorkspaceModel} needs that a test almost never cares about. */
const EMPTY_MODEL = {
  availableMcpServers: [],
  availableSkills: [],
  apps: [],
  cwd: "/workspace",
  homeDir: "/home/dev",
  instructionFiles: [],
  mcpSecretSightings: [],
  mcpEnvironmentVariables: [],
  mcpServers: [],
  sharedSkills: [],
  skills: [],
  unusableMcpServers: [],
} as const;

/**
 * Builds a {@link WorkspaceModel} from only the parts a test is about.
 *
 * The model is the argument to every check, so it grows whenever the kernel learns something new
 * about the machine — and each new required field would otherwise mean editing every fixture that
 * ever constructed one. Defaults live here so that edit is this file.
 *
 * `manifest` and `sharedInstructions` have no meaningful empty value, so they stay required.
 */
export function createWorkspaceModel(
  model: Pick<WorkspaceModel, "manifest" | "sharedInstructions"> & Partial<WorkspaceModel>,
): WorkspaceModel {
  return { ...EMPTY_MODEL, ...model };
}
