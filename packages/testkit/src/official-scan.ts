import { OFFICIAL_PLUGINS } from "@tryaura/aura-cli/plugins";
import type { Adapter, Check, WorkspaceModel } from "@tryaura/aura-sdk";
import { buildWorkspaceModel, createEnvironment } from "@tryaura/core";

/** The directories a seed exposes, which is all a scan needs to locate configuration. */
export interface ScannableSeed {
  readonly homeDir: string;
  readonly pathDir: string;
  readonly workspaceDir: string;
}

/**
 * Scans a seed with real official adapters, bypassing the CLI.
 *
 * A check that reasons about which file an entry came from cannot be exercised through fixtures
 * alone: the modelled scope and the source file it belongs to are decided by the adapter's parser.
 */
export async function officialScan(
  seed: ScannableSeed,
  adapterIds: readonly string[],
): Promise<WorkspaceModel> {
  const scan = await buildWorkspaceModel({
    adapters: adapterIds.map((id) => officialAdapter(id)),
    environment: createEnvironment({
      cwd: seed.workspaceDir,
      environmentVariables: { PATH: seed.pathDir },
      homeDir: seed.homeDir,
      path: seed.pathDir,
    }),
  });
  return scan.model;
}

function officialAdapter(id: string): Adapter {
  for (const plugin of OFFICIAL_PLUGINS) {
    const adapter = plugin.adapters?.find((candidate) => candidate.id === id);
    if (adapter !== undefined) {
      return adapter;
    }
  }
  throw new Error(`Official adapter ${id} is missing.`);
}

function officialCheck(id: string): Check {
  for (const plugin of OFFICIAL_PLUGINS) {
    const check = plugin.checks?.find((candidate) => candidate.id === id);
    if (check !== undefined) {
      return check;
    }
  }
  throw new Error(`Official check ${id} is missing.`);
}

/** The guided check with this id, narrowed so a test can call `fix` without re-checking. */
export function guidedCheck(id: string): Extract<Check, { readonly fixability: "guided" }> {
  const check = officialCheck(id);
  if (check.fixability !== "guided") {
    throw new Error(`Official check ${id} is not guided.`);
  }
  return check;
}
