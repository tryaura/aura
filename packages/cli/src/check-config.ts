import type { AuraConfigurationLayer, AuraManifestState, Environment } from "@tryaura/aura-sdk";
import { AURA_TEAM_PRESET_PATH } from "@tryaura/core";

import type { AuraCliContext } from "./cli-context.js";
import { resolveRuntimeConfig, type RuntimeConfigResult } from "./runtime-config.js";
import type { CliBranding } from "./types.js";
import type { ReportConfiguration } from "./report-types.js";

/** Resolves the effective configuration for one `check` run. */
export function resolveCheckConfiguration(options: {
  readonly cliLayer: AuraConfigurationLayer;
  readonly cliReference: string | undefined;
  readonly context: AuraCliContext;
  readonly environment: Environment;
  readonly manifest: AuraManifestState;
  readonly noCache: boolean | undefined;
  readonly online: boolean;
}): Promise<RuntimeConfigResult> {
  return resolveRuntimeConfig({
    cliLayer: options.cliLayer,
    cliReference: options.cliReference,
    defaultPreset: options.context.defaultPreset,
    defaults: options.context.defaults,
    environment: options.environment,
    manifest: options.manifest,
    noCache: options.noCache,
    online: options.online,
    registry: options.context.registry,
  });
}

/**
 * The configuration note a human `check` run prints about the repository preset.
 *
 * `check` never prompts and never writes the manifest, so an untrusted or broken repository
 * preset is reported rather than resolved: the note names the command that can act on it.
 */
export function repoPresetNote(
  configured: Extract<RuntimeConfigResult, { status: "ready" }>,
  branding: CliBranding,
): string | undefined {
  const repo = configured.repoPreset;
  if (repo === undefined || repo.status === "applied") {
    return undefined;
  }
  return (
    `Repository preset ${AURA_TEAM_PRESET_PATH} is present but not trusted on this machine, ` +
    `so it was not applied. Run ${branding.command} setup to review and trust it.`
  );
}

/** Stable machine-readable state for the configuration carried by check output. */
export function reportConfiguration(
  configured: Extract<RuntimeConfigResult, { status: "ready" }>,
): ReportConfiguration | undefined {
  const repo = configured.repoPreset;
  if (repo === undefined) {
    return undefined;
  }
  return Object.freeze({
    repositoryPreset: Object.freeze({
      path: AURA_TEAM_PRESET_PATH,
      status: repo.status,
    }),
  });
}
