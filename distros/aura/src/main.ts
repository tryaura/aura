#!/usr/bin/env node
import { runCli } from "@tryaura/aura-cli";

import packageManifest from "../package.json" with { type: "json" };

await runCli({
  branding: {
    command: "aura",
    description: "Agent Unification & Repair Assistant",
    displayName: "Aura",
    version: packageManifest.version,
  },
  plugins: [],
});
