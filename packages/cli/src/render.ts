import type { Writable } from "node:stream";

import type { Check, Finding, FindingLocation } from "@tryaura/aura-sdk";
import { describeFailure } from "@tryaura/core";
import { pluralize } from "@tryaura/core/pluralize";

import { renderFindingPresentation } from "./metadata-table.js";
import { notFoundLine } from "./not-found-line.js";
import {
  createCheckExplanation,
  createOperationalFailureReport,
  type CheckReport,
} from "./report.js";
import type { ReportApp } from "./report-shapes.js";
import { safe, safeFindingText, safeMultiline } from "./safe-text.js";
import { createStyle, type Style } from "./style.js";
import type { CliBranding } from "./types.js";

export function renderJson(report: CheckReport, output: Writable): void {
  output.write(`${JSON.stringify(report)}\n`);
}

/**
 * Emits the document a `--json` run still owes the caller when the run itself failed.
 *
 * The failure detail rides along only under `--detail`, mirroring how the human explanation on
 * stderr withholds it: the thrown text may quote a file that holds an API token.
 */
export function renderOperationalFailureJson(
  error: unknown,
  withDetail: boolean,
  output: Writable,
): void {
  renderJson(
    createOperationalFailureReport(
      "check failed unexpectedly. This is a bug in a plugin or the CLI.",
      withDetail ? describeFailure(error) : undefined,
    ),
    output,
  );
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

export function renderHuman(
  report: CheckReport,
  branding: CliBranding,
  output: Writable,
  colorDepth = 0,
): void {
  const style = createStyle(colorDepth);
  output.write(`${branding.displayName} check\n`);

  if (report.passedChecks.length > 0) {
    renderGroup(
      "✓",
      `Passed (${String(report.passedChecks.length)})`,
      report.passedChecks.map((check) => `[${safe(check.id)}] ${safe(check.title)}`),
      output,
      style.green,
    );
  } else if (report.status === "empty") {
    renderGroup(
      "!",
      "Nothing to check",
      [
        "No checks are registered. This build of the CLI ships no plugins, so nothing about this machine was inspected.",
      ],
      output,
      style.yellow,
    );
  } else if (report.findings.length === 0 && report.diagnostics.length === 0) {
    renderGroup("✓", "Clean", ["No checks reported issues."], output, style.green);
  }

  renderFindingGroup("·", "Informational", report, "info", output, style);
  renderFindingGroup("!", "Warnings", report, "warn", output, style, style.yellow);
  renderFindingGroup("✗", "Errors", report, "error", output, style, style.red);

  renderNextSteps(report, branding, output);

  if (report.diagnostics.length > 0) {
    renderGroup(
      "✗",
      `Run errors (${String(report.diagnostics.length)})`,
      report.diagnostics.flatMap((diagnostic) => [
        `[${safe(diagnostic.id)}:${diagnostic.phase}] ${safe(diagnostic.message)}`,
        ...(diagnostic.detail === undefined ? [] : [`  ${safe(diagnostic.detail)}`]),
      ]),
      output,
      style.red,
    );
  }

  // The inventory the counts above were measured against: what was inspected, then what was looked
  // for and not found. The install instructions themselves belong to the app the user picks, not
  // to every app they have never wanted.
  const detected = report.apps.filter((app) => app.detection.installed);
  if (detected.length > 0) {
    renderGroup("·", `Detected (${String(detected.length)})`, detected.map(detectedLine), output);
  }
  const skipped = report.apps.filter((app) => !app.detection.installed);
  if (skipped.length > 0) {
    renderGroup(
      "·",
      `Not found (${String(skipped.length)})`,
      [
        ...skipped.map((app) => notFoundLine(app.displayName, app.detectionScope)),
        `Run ${branding.command} setup to install and manage any of them`,
      ],
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
  output.write(`${verdictStyle(report, style)(verdictMessage(report))}\n`);
}

/**
 * The next action for every finding the run could not resolve by itself.
 *
 * A count and a command, not the findings again: every one of them was just printed above with its
 * check id, and repeating them doubles the report exactly when it should be getting shorter. On a
 * plain run this is what reveals `--fix` exists at all; after a fix run it is what remains.
 */
function renderNextSteps(report: CheckReport, branding: CliBranding, output: Writable): void {
  const applied = report.fixes?.some((fix) => fix.status === "applied") ?? false;
  const auto = report.findings.filter((finding) => finding.fixability === "auto").length;
  const guided = report.findings.filter((finding) => finding.fixability === "guided").length;
  const manual = report.findings.filter((finding) => finding.fixability === "manual").length;

  const lines: string[] = [];
  if (auto > 0) {
    lines.push(
      `${String(auto)} ${pluralize(auto, "finding")} can be fixed automatically — run ${branding.command} check --fix`,
    );
  }
  if (guided > 0) {
    lines.push(
      `${String(guided)} ${pluralize(guided, "finding")} ${pluralize(guided, "offers", "offer")} guided resolutions — run ${branding.command} check --fix --interactive`,
    );
  }
  if (manual > 0) {
    lines.push(
      `${String(manual)} ${pluralize(manual, "finding")} ${pluralize(manual, "needs", "need")} a manual edit — run ${branding.command} check --explain <id>`,
    );
  }
  if (lines.length === 0) {
    return;
  }
  const heading = applied ? "Remaining work" : "Next steps";
  renderGroup("·", `${heading} (${String(auto + guided + manual)})`, lines, output);
}

/** Marks the findings a fix run could act on; manual ones carry no tag, only guidance. */
const FIXABILITY_TAGS: Readonly<Record<string, string>> = Object.freeze({
  auto: "(fixable)",
  guided: "(guided fix)",
});

function renderFindingGroup(
  symbol: string,
  label: string,
  report: CheckReport,
  severity: Finding["severity"],
  output: Writable,
  style: Style,
  decorate?: (text: string) => string,
): void {
  const findings = report.findings.filter((finding) => finding.severity === severity);
  if (findings.length === 0) {
    return;
  }

  renderGroup(
    symbol,
    `${label} (${String(findings.length)})`,
    findings.flatMap((finding) => {
      const tag = FIXABILITY_TAGS[finding.fixability];
      return [
        `[${safe(finding.checkId)}] ${safeFindingText(finding.message)}${tag === undefined ? "" : ` ${style.dim(tag)}`}`,
        ...(finding.details === undefined ? [] : [`  ${safeFindingText(finding.details)}`]),
        ...(finding.locations ?? []).map((location) => `  at ${locationText(location)}`),
        ...renderFindingPresentation(finding).map((line) => `  ${line}`),
      ];
    }),
    output,
    decorate,
  );
}

function locationText(location: FindingLocation): string {
  const line = location.line === undefined ? "" : `:${String(location.line)}`;
  const column = line === "" || location.column === undefined ? "" : `:${String(location.column)}`;
  return `${safe(location.path)}${line}${column}`;
}

/** One line of inventory per inspected app: identity, then how far Aura can see into it. */
function detectedLine(app: ReportApp): string {
  const version = app.detection.version === undefined ? "" : ` ${safe(app.detection.version)}`;
  const auth =
    app.detection.authenticated === undefined
      ? ""
      : app.detection.authenticated
        ? ", signed in"
        : ", not signed in";
  return `${safe(app.displayName)}${version} — ${supportText(app)}${auth}`;
}

function supportText(app: ReportApp): string {
  if (app.support === undefined || app.support.status === "unknown") {
    return "support unknown";
  }
  if (app.support.status === "unsupported") {
    return `unsupported (supports ${safe(app.support.supportedRange)})`;
  }
  return "supported";
}

function renderGroup(
  symbol: string,
  heading: string,
  entries: readonly string[],
  output: Writable,
  decorate: (text: string) => string = (text) => text,
): void {
  output.write(`\n${decorate(`${symbol} ${heading}`)}\n`);
  for (const entry of entries) {
    output.write(`  ${entry}\n`);
  }
}

function summaryMessage(report: CheckReport): string {
  const { errors, informational, passed, warnings } = report.summary;
  return `${String(passed)} passed, ${String(informational)} informational, ${String(warnings)} ${pluralize(warnings, "warning")}, ${String(errors)} ${pluralize(errors, "error")}`;
}

function verdictMessage(report: CheckReport): string {
  return `Status: ${report.status} (exit ${String(report.summary.exitCode)})`;
}

function verdictStyle(report: CheckReport, style: Style): (text: string) => string {
  switch (report.status) {
    case "clean": {
      return style.green;
    }
    case "empty":
    case "warning": {
      return style.yellow;
    }
    default: {
      return style.red;
    }
  }
}
