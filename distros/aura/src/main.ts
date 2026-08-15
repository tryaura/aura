#!/usr/bin/env node
import { runCli } from "@tryaura/aura-cli";

await runCli({
  branding: {
    command: "aura",
    description: "Agent Unification & Repair Assistant",
    displayName: "Aura",
    version: "0.0.0",
  },
  plugins: [],
});
