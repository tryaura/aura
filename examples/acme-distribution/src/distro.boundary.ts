import process from "node:process";

import type { CliDistro } from "@tryaura/aura-cli";
import { OFFICIAL_PLUGINS, OFFICIAL_REGISTRY_OPTIONS } from "@tryaura/aura-cli/plugins";

import internalPlugin from "./plugin.js";
import { createAcmeTelemetrySink } from "./telemetry.js";

// Composition is this distribution's process boundary — the one place it may read the environment,
// the same way the CLI's own boundary does. A real distribution would compose its collector
// endpoint at build time instead of routing it through a variable like this.
export function createAcmeDistro(): CliDistro {
  const telemetryFile = process.env["ACME_TELEMETRY_FILE"];
  return {
    branding: {
      command: "acmedev",
      description: "Acme's agent configuration doctor",
      displayName: "Acme Dev",
      docsUrl: "https://engineering.acme.example/acmedev",
      version: "0.5.2",
    },
    defaultPreset: "plugin:acme/platform",
    plugins: [...OFFICIAL_PLUGINS, internalPlugin],
    registry: OFFICIAL_REGISTRY_OPTIONS,
    ...(telemetryFile === undefined || telemetryFile === ""
      ? {}
      : { telemetry: createAcmeTelemetrySink(telemetryFile) }),
  };
}
