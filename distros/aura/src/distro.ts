import { createHttpTelemetrySink, type CliDistro } from "@tryaura/aura-cli";
import { OFFICIAL_PLUGINS, OFFICIAL_REGISTRY_OPTIONS } from "@tryaura/aura-cli/plugins";
import type { HttpPostRequest, HttpPostResult } from "@tryaura/aura-sdk";

import packageManifest from "../package.json" with { type: "json" };

const TELEMETRY_URL = "https://tryaura.sh/api/telemetry/v1";

export interface AuraDistroOptions {
  readonly telemetryPost?: ((request: HttpPostRequest) => Promise<HttpPostResult>) | undefined;
  readonly version?: string | undefined;
}

/** Composes the official distribution, adding telemetry only to a stamped release build. */
export function createAuraDistro(options: AuraDistroOptions = {}): CliDistro {
  const version = options.version ?? packageManifest.version;
  return {
    branding: {
      command: "aura",
      description: "Agent Unification & Repair Assistant",
      displayName: "Aura",
      docsUrl: "https://tryaura.sh/docs/quickstart",
      version,
    },
    plugins: OFFICIAL_PLUGINS,
    registry: OFFICIAL_REGISTRY_OPTIONS,
    ...(version === "0.0.0"
      ? {}
      : {
          telemetry: createHttpTelemetrySink({
            maxBatch: 5,
            maxBufferedEvents: 5,
            ...(options.telemetryPost === undefined ? {} : { post: options.telemetryPost }),
            timeoutMs: 250,
            url: TELEMETRY_URL,
          }),
        }),
  };
}

export const AURA_DISTRO: CliDistro = createAuraDistro();
