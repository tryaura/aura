import type { Writable } from "node:stream";

import type { AuraEffectiveConfig, Check } from "@tryaura/aura-sdk";
import { effectiveCheckConfiguration } from "@tryaura/core";

import { createCheckExplanation } from "./report.js";
import type { ReportConfiguration } from "./report-types.js";
import { safe, safeMultiline } from "./safe-text.js";
import type { CliBranding } from "./types.js";

/** Describes the remediation mode and the command that can act on it. */
const FIXABILITY_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  auto: "auto — apply with check --fix",
  guided: "guided — walk through choices with check --fix --interactive",
  manual: "manual — follow the guidance below",
});

export function renderExplanation(
  check: Check,
  config: AuraEffectiveConfig,
  branding: CliBranding,
  output: Writable,
  configuration?: ReportConfiguration,
): void {
  const effective = effectiveCheckConfiguration(check, config);
  const fixability = FIXABILITY_DESCRIPTIONS[check.fixability] ?? check.fixability;
  output.write(`${branding.displayName} check ${safe(check.id)}\n\n`);
  renderConfiguration(configuration, branding, output);
  output.write(`${safe(check.title)}\n`);
  output.write(
    `Enabled: ${effective.enabled.value ? "yes" : "no"} — set by ${safe(effective.enabled.provenance.label)}\n`,
  );
  output.write(
    `Severity: ${safe(effective.severity.value)} — set by ${safe(effective.severity.provenance.label)}\n`,
  );
  output.write(
    `Thresholds: ${safe(JSON.stringify(effective.thresholds.value))} — set by ${safe(effective.thresholds.provenance.label)}\n`,
  );
  if (config.preset !== undefined) {
    output.write(`Preset: ${safe(config.preset.name)} (${safe(config.preset.reference)})\n`);
  }
  output.write(`Fixability: ${safe(fixability)}\n`);
  output.write(`\n${safeMultiline(check.explain)}\n`);
}

/** Emits one explanation as a document another tool can read. */
export function renderExplanationJson(
  check: Check,
  config: AuraEffectiveConfig,
  output: Writable,
  configuration?: ReportConfiguration,
): void {
  output.write(`${JSON.stringify(createCheckExplanation(check, config, configuration))}\n`);
}

function renderConfiguration(
  configuration: ReportConfiguration | undefined,
  branding: CliBranding,
  output: Writable,
): void {
  const repo = configuration?.repositoryPreset;
  if (repo === undefined) {
    return;
  }
  const status =
    repo.status === "applied"
      ? "applied"
      : `held because it is not trusted; run ${branding.command} setup to review it`;
  output.write(`Repository preset: ${safe(repo.path)} — ${safe(status)}\n\n`);
}
