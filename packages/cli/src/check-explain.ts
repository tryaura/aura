import type { Writable } from "node:stream";

import type { AuraEffectiveConfig, Check } from "@tryaura/aura-sdk";

import { renderExplanation, renderExplanationJson } from "./render-explain.js";
import { safe } from "./safe-text.js";
import type { CliBranding, CliExitCode } from "./types.js";

/** Everything `check --explain` needs from the command context. */
export interface ExplainCheckContext {
  readonly branding: CliBranding;
  readonly checks: readonly Check[];
  readonly config: AuraEffectiveConfig;
  readonly json: boolean;
  readonly report: Writable;
  readonly stderr: Writable;
  readonly stdout: Writable;
}

/**
 * Resolves a check id the way a developer typed it and renders its explanation.
 *
 * Matching is case-insensitive after an exact match, so `env-001` resolves conventionally.
 */
export function explainCheck(id: string, context: ExplainCheckContext): CliExitCode {
  const { checks } = context;
  const check =
    checks.find((candidate) => candidate.id === id) ??
    checks.find((candidate) => candidate.id.toLowerCase() === id.toLowerCase());
  if (check === undefined) {
    const available = checks.map((candidate) => candidate.id).join(", ");
    context.stderr.write(`${context.branding.displayName}: unknown check ID: ${safe(id)}\n`);
    if (available !== "") {
      context.stderr.write(`Available check IDs: ${safe(available)}\n`);
    }
    return 2;
  }

  if (context.json) {
    renderExplanationJson(check, context.config, context.report);
  } else {
    renderExplanation(check, context.config, context.branding, context.stdout);
  }
  return 0;
}
