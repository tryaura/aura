#!/usr/bin/env node
import claudeCode from "@tryaura/adapter-claude-code";
import cursor from "@tryaura/adapter-cursor";
import { runCli } from "@tryaura/aura-cli";

import packageManifest from "../package.json" with { type: "json" };

await runCli({
  branding: {
    command: "aura",
    description: "Agent Unification & Repair Assistant",
    displayName: "Aura",
    version: packageManifest.version,
  },
  plugins: [claudeCode, cursor],
});
