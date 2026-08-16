import type { Writable } from "node:stream";

import type { Check, Finding } from "@tryaura/aura-sdk";

import { renderFindingPresentation } from "./metadata-table.js";
import { createCheckExplanation, type CheckReport } from "./report.js";
import { safe, safeFindingText, safeMultiline } from "./safe-text.js";
import type { CliBranding } from "./types.js";

export { safe, safeMultiline } from "./safe-text.js";

export function renderJson(report: CheckReport, output: Writable): void {
  output.write(`${JSON.stringify(report)}\n`);
}

/** Describes the remediation mode and the command that can act on it. */
const FIXABILITY_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  auto: "auto — apply with check --fix",
  guided: "guided — walk through choices with check --fix --interactive",
  manual: "manual — follow the guidance below",
});

export function renderExplanation(check: Check, branding: CliBranding, output: Writable): void {
  const fixability = FIXABILITY_DESCRIPTIONS[check.fixability] ?? check.fixability;
  output.write(`${branding.displayName} check ${safe(check.id)}\n\n`);
  output.write(`${safe(check.title)}\n`);
  output.write(`Fixability: ${safe(fixability)}\n`);
  output.write(`\n${safeMultiline(check.explain)}\n`);
}

/** Emits one explanation as a document another tool can read. */
export function renderExplanationJson(check: Check, output: Writable): void {
  output.write(`${JSON.stringify(createCheckExplanation(check))}\n`);
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

  renderRemainingWork(report, branding, output);

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

  const skipped = report.apps.filter((app) => !app.detection.installed);
  if (skipped.length > 0) {
    renderGroup(
      "·",
      `Not found (${String(skipped.length)})`,
      skipped.map((app) => safe(app.displayName)),
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

/**
 * Says what a `--fix` run could not do for the user, once it has done what it could.
 *
 * A count and a command, not the findings again: every one of them was just printed above with its
 * check id, and repeating them doubles the report exactly when it should be getting shorter.
 */
function renderRemainingWork(report: CheckReport, branding: CliBranding, output: Writable): void {
  const applied = report.fixes?.some((fix) => fix.status === "applied") ?? false;
  const guided = report.findings.filter((finding) => finding.fixability === "guided").length;
  const manual = report.findings.filter((finding) => finding.fixability === "manual").length;
  if (!applied || guided + manual === 0) {
    return;
  }

  const lines: string[] = [];
  if (guided > 0) {
    lines.push(
      `${String(guided)} finding(s) offer guided resolutions — run ${branding.command} check --fix --interactive`,
    );
  }
  if (manual > 0) {
    lines.push(
      `${String(manual)} finding(s) need a manual edit — run ${branding.command} check --explain <id>`,
    );
  }
  renderGroup("·", `Remaining work (${String(guided + manual)})`, lines, output);
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
