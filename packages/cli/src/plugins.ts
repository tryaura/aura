import claudeCodePluginSource from "@tryaura/adapter-claude-code";
import codexPluginSource from "@tryaura/adapter-codex";
import cursorPluginSource from "@tryaura/adapter-cursor";
import type { AuraPlugin } from "@tryaura/aura-sdk";
import checksCorePluginSource from "@tryaura/checks-core";
import officialContentPluginSource from "@tryaura/content-official";

import type { CliRegistryOptions } from "./types.js";

export const checksCorePlugin: AuraPlugin = checksCorePluginSource;
export const claudeCodePlugin: AuraPlugin = claudeCodePluginSource;
export const codexPlugin: AuraPlugin = codexPluginSource;
export const cursorPlugin: AuraPlugin = cursorPluginSource;
export const officialContentPlugin: AuraPlugin = officialContentPluginSource;

/** Official plugins composed by the Aura executable and available to branded distributions. */
export const OFFICIAL_PLUGINS: readonly AuraPlugin[] = Object.freeze([
  claudeCodePlugin,
  codexPlugin,
  cursorPlugin,
  checksCorePlugin,
  officialContentPlugin,
]);

/** Registry privileges required by the official checks package's stable bare check ids. */
export const OFFICIAL_REGISTRY_OPTIONS: CliRegistryOptions = Object.freeze({
  bareCheckIdPlugins: Object.freeze(["checks-core"]),
});
