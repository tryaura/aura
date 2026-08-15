import type { Writable } from "node:stream";

import type { Finding } from "@tryaura/aura-sdk";

import type { CheckReport } from "./report.js";
import type { CliBranding } from "./types.js";

export function renderJson(report: CheckReport, output: Writable): void {
  output.write(`${JSON.stringify(report)}\n`);
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
      `Scan errors (${String(report.diagnostics.length)})`,
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
      `[${safe(finding.checkId)}] ${safe(finding.message)}`,
      ...(finding.details === undefined ? [] : [`  ${safe(finding.details)}`]),
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

/**
 * Neutralizes control characters in text Aura did not write itself.
 *
 * Findings and diagnostics quote what was read out of third-party agent configuration, so their
 * text is attacker-influenced in the same way a filename is. An escape sequence reaching the
 * terminal can repaint the report — turning an error line into a passing one — or drive the
 * terminal itself, so every byte below `space` is replaced before it is written.
 */
export function safe(value: string): string {
  let result = "";

  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    result += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : character;
  }

  return result;
}
