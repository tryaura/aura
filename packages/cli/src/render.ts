import type { Writable } from "node:stream";

import { intro, log, outro } from "@clack/prompts";
import type { Finding } from "@tryaura/aura-sdk";

import type { CheckReport } from "./report.js";
import type { CliBranding } from "./types.js";

export function renderJson(report: CheckReport, output: Writable): void {
  output.write(`${JSON.stringify(report)}\n`);
}

export function renderHuman(report: CheckReport, branding: CliBranding, output: Writable): void {
  const options = { output, withGuide: false };
  intro(`${branding.displayName} check`, options);

  if (report.passedChecks.length > 0) {
    renderGroup(
      "✓",
      `Passed (${String(report.passedChecks.length)})`,
      report.passedChecks.map((check) => `[${check.id}] ${check.title}`),
      output,
    );
  } else if (report.findings.length === 0 && report.diagnostics.length === 0) {
    renderGroup("✓", "Clean", ["No checks reported issues."], output);
  }

  renderFindingGroup("✓", "Informational", report, "info", output);
  renderFindingGroup("!", "Warnings", report, "warn", output);
  renderFindingGroup("✗", "Errors", report, "error", output);

  if (report.diagnostics.length > 0) {
    renderGroup(
      "✗",
      `Scan errors (${String(report.diagnostics.length)})`,
      report.diagnostics.map(
        (diagnostic) => `[${diagnostic.adapterId}:${diagnostic.phase}] ${diagnostic.message}`,
      ),
      output,
    );
  }

  if (branding.docsUrl !== undefined) {
    log.info(`Docs: ${branding.docsUrl}`, options);
  }

  outro(summaryMessage(report), options);
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
    findings.map((finding) => `[${finding.checkId}] ${finding.message}`),
    output,
  );
}

function renderGroup(
  symbol: string,
  heading: string,
  entries: readonly string[],
  output: Writable,
): void {
  log.message([`${symbol} ${heading}`, ...entries], {
    output,
    withGuide: false,
  });
}

function summaryMessage(report: CheckReport): string {
  const { errors, informational, passed, warnings } = report.summary;
  return `${String(passed)} passed, ${String(informational)} informational, ${String(warnings)} warnings, ${String(errors)} errors`;
}
