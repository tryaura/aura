#!/usr/bin/env node
import packageManifest from "../package.json" with { type: "json" };

import { OFFICIAL_PLUGINS, OFFICIAL_REGISTRY_OPTIONS } from "./plugins.js";
import { runCli } from "./run.js";

await runCli({
  branding: {
    command: "aura",
    description: "Agent Unification & Repair Assistant",
    displayName: "Aura",
    version: packageManifest.version,
  },
  plugins: OFFICIAL_PLUGINS,
  registry: OFFICIAL_REGISTRY_OPTIONS,
});
