import type { Writable } from "node:stream";

import type { Check, Finding } from "@tryaura/aura-sdk";

import { renderFindingPresentation } from "./metadata-table.js";
import type { CheckReport } from "./report.js";
import { safe, safeFindingText, safeMultiline } from "./safe-text.js";
import type { CliBranding } from "./types.js";

export { safe, safeMultiline } from "./safe-text.js";

export function renderJson(report: CheckReport, output: Writable): void {
  output.write(`${JSON.stringify(report)}\n`);
}

/**
 * Describes how a check's fix would be applied, and that nothing applies it yet.
 *
 * `fixability` states what a check is *capable* of. Printing "auto" on its own reads as a promise
 * that some command will do it, and this build ships no such command, so the capability and its
 * availability are reported as two separate facts.
 */
const FIXABILITY_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  auto: "auto — Aura can write this fix once fixes can be applied",
  guided: "guided — Aura describes the edit; you make it",
  manual: "manual — follow the guidance below",
});

const FIX_AVAILABILITY = "Applying fixes is not available in this build; checks report only.";

export function renderExplanation(check: Check, branding: CliBranding, output: Writable): void {
  const fixability = FIXABILITY_DESCRIPTIONS[check.fixability] ?? check.fixability;
  output.write(`${branding.displayName} check ${safe(check.id)}\n\n`);
  output.write(`${safe(check.title)}\n`);
  output.write(`Fixability: ${safe(fixability)}\n`);
  if (check.fixability !== "manual") {
    output.write(`${FIX_AVAILABILITY}\n`);
  }
  output.write(`\n${safeMultiline(check.explain)}\n`);
}

/** Emits one explanation as a document another tool can read. */
export function renderExplanationJson(check: Check, output: Writable): void {
  output.write(
    `${JSON.stringify({
      explain: check.explain,
      fixability: check.fixability,
      fixesApplicable: false,
      id: check.id,
      scope: check.scope,
      severity: check.defaultSeverity,
      title: check.title,
    })}\n`,
  );
}

export function renderHuman(report: CheckReport, branding: CliBranding, output: Writable): void {
  output.write(`${branding.displayName} check\n`);

  if (report.passedChecks.length > 0) {
    renderGroup(
      "✓",
      `Passed (${String(report.passedChecks.length)})`,
      report.passedChecks.map((check) => `[${safe(check.id)}] ${safe(check.title)}`),
      output,
    );
  } else if (report.status === "empty") {
    renderGroup(
      "!",
      "Nothing to check",
      [
        "No checks are registered. This build of the CLI ships no plugins, so nothing about this machine was inspected.",
      ],
      output,
    );
  } else if (report.findings.length === 0 && report.diagnostics.length === 0) {
    renderGroup("✓", "Clean", ["No checks reported issues."], output);
  }

  renderFindingGroup("·", "Informational", report, "info", output);
  renderFindingGroup("!", "Warnings", report, "warn", output);
  renderFindingGroup("✗", "Errors", report, "error", output);

  if (report.diagnostics.length > 0) {
    renderGroup(
      "✗",
      `Run errors (${String(report.diagnostics.length)})`,
      report.diagnostics.flatMap((diagnostic) => [
        `[${safe(diagnostic.id)}:${diagnostic.phase}] ${safe(diagnostic.message)}`,
        ...(diagnostic.detail === undefined ? [] : [`  ${safe(diagnostic.detail)}`]),
      ]),
      output,
    );
  }

  if (report.skipped.length > 0) {
    renderGroup(
      "·",
      `Not found (${String(report.skipped.length)})`,
      report.skipped.map((app) => safe(app.displayName)),
      output,
    );
  }

  // Every finding is printed with its check id, so the way to read more about one is only useful
  // if it is on screen next to them.
  if (report.findings.length > 0) {
    renderGroup(
      "·",
      "Explain a check",
      [`${branding.command} check --explain ${safe(report.findings[0]?.checkId ?? "")}`],
      output,
    );
  }

  if (branding.docsUrl !== undefined) {
    renderGroup("·", `Docs: ${branding.docsUrl}`, [], output);
  }

  output.write(`\n${summaryMessage(report)}\n`);
}

function renderFindingGroup(
  symbol: string,
  label: string,
  report: CheckReport,
  severity: Finding["severity"],
  output: Writable,
): void {
  const findings = report.findings.filter((finding) => finding.severity === severity);
  if (findings.length === 0) {
    return;
  }

  renderGroup(
    symbol,
    `${label} (${String(findings.length)})`,
    findings.flatMap((finding) => [
      `[${safe(finding.checkId)}] ${safeFindingText(finding.message)}`,
      ...(finding.details === undefined ? [] : [`  ${safeFindingText(finding.details)}`]),
      ...renderFindingPresentation(finding).map((line) => `  ${line}`),
    ]),
    output,
  );
}

function renderGroup(
  symbol: string,
  heading: string,
  entries: readonly string[],
  output: Writable,
): void {
  output.write(`\n${symbol} ${heading}\n`);
  for (const entry of entries) {
    output.write(`  ${entry}\n`);
  }
}

function summaryMessage(report: CheckReport): string {
  const { errors, informational, passed, warnings } = report.summary;
  return `${String(passed)} passed, ${String(informational)} informational, ${String(warnings)} warnings, ${String(errors)} errors`;
}
