import type { CliDistro } from "@tryaura/aura-cli";
import { OFFICIAL_PLUGINS, OFFICIAL_REGISTRY_OPTIONS } from "@tryaura/aura-cli/plugins";

import packageManifest from "../package.json" with { type: "json" };

export const AURA_DISTRO: CliDistro = {
  branding: {
    command: "aura",
    description: "Agent Unification & Repair Assistant",
    displayName: "Aura",
    docsUrl: "https://tryaura.sh/docs/quickstart",
    version: packageManifest.version,
  },
  plugins: OFFICIAL_PLUGINS,
  registry: OFFICIAL_REGISTRY_OPTIONS,
};
