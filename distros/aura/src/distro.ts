import claudeCode from "@tryaura/adapter-claude-code";
import codex from "@tryaura/adapter-codex";
import cursor from "@tryaura/adapter-cursor";
import type { CliDistro } from "@tryaura/aura-cli";
import checksCore from "@tryaura/checks-core";
import officialContent from "@tryaura/content-official";

import packageManifest from "../package.json" with { type: "json" };

export const AURA_DISTRO: CliDistro = {
  branding: {
    command: "aura",
    description: "Agent Unification & Repair Assistant",
    displayName: "Aura",
    version: packageManifest.version,
  },
  plugins: [claudeCode, codex, cursor, checksCore, officialContent],
  registry: { bareCheckIdPlugins: ["checks-core"] },
};
