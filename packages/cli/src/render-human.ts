import type { Writable } from "node:stream";

import type { Check } from "@tryaura/aura-sdk";
import { pluralize } from "@tryaura/core/pluralize";

import { notFoundLine } from "./not-found-line.js";
import { findingsHaveHiddenDetail, renderFindingSection } from "./render-human-findings.js";
import type { HumanCheckRenderOptions, HumanRenderContext } from "./render-human-types.js";
import type { CheckReport } from "./report.js";
import type { ReportApp } from "./report-shapes.js";
import { safe } from "./safe-text.js";
import { createStyle, type Style } from "./style.js";
import type { CliBranding } from "./types.js";

export function renderHumanCheckReport(
  report: CheckReport,
  branding: CliBranding,
  output: Writable,
  options: HumanCheckRenderOptions,
): void {
  const context = { options, style: createStyle(options.colorDepth) };
  output.write(`${branding.displayName} check — ${humanVerdict(report)}\n`);
  renderHeadline(report, output, context);

  if (report.status === "empty") {
    renderSection(
      "!",
      "Nothing to check",
      ["No checks are registered. This build ships no plugins, so nothing was inspected."],
      output,
      context.style.yellow,
    );
  }
  renderDiagnostics(report, output, context);
  renderRecommendation(report, branding, output, context);

  const checks = new Map(options.checks.map((check) => [check.id, check]));
  renderFindingSection(
    "Available fixes",
    report.findings.filter((finding) => finding.fixability !== "manual"),
    checks,
    output,
    context,
  );
  renderFindingSection(
    "Manual attention",
    report.findings.filter(
      (finding) => finding.fixability === "manual" && finding.severity !== "info",
    ),
    checks,
    output,
    context,
  );
  renderFindingSection(
    "Suggestions",
    report.findings.filter(
      (finding) => finding.fixability === "manual" && finding.severity === "info",
    ),
    checks,
    output,
    context,
  );

  if (options.verbose) {
    renderInventory(report, branding, output, context);
  }
  renderMore(report, branding, output, context, checks);
  output.write(`\n${verdictStyle(report, context.style)(resultLine(report))}\n`);
}

/**
 * Where to go from a report that has already said what it found.
 *
 * Every finding prints its check id, so the command that turns an id into an explanation has to be
 * on screen next to them — an id the user cannot act on is decoration.
 */
function renderMore(
  report: CheckReport,
  branding: CliBranding,
  output: Writable,
  context: HumanRenderContext,
  checks: ReadonlyMap<string, Check>,
): void {
  const lines: string[] = [];
  if (report.findings.length > 0) {
    lines.push(`Explain any check: ${branding.command} check --explain <id>`);
  }
  if (!context.options.verbose && hasHiddenDetail(report, checks)) {
    lines.push(
      `Show every occurrence, location, passed check, and application: ${branding.command} check --verbose`,
    );
  }
  if (branding.docsUrl !== undefined) {
    lines.push(`Docs: ${branding.docsUrl}`);
  }
  if (lines.length > 0) {
    renderSection("·", "More", lines, output);
  }
}

function renderHeadline(report: CheckReport, output: Writable, context: HumanRenderContext): void {
  output.write(
    `\n${[
      countPhrase(report.summary.errors, "error"),
      countPhrase(report.summary.warnings, "warning"),
      countPhrase(report.summary.informational, "suggestion"),
    ].join(" · ")}\n`,
  );
  const detected = report.apps.filter((app) => app.detection.installed).length;
  const inspected = `${String(report.summary.passed)} ${pluralize(report.summary.passed, "check")} passed`;
  const apps = `${String(detected)} ${pluralize(detected, "application")} detected`;
  // A green ✓ over two zeros claims reassurance the run did not earn: an empty or crashed scan
  // inspected nothing, and the glyph has to say so on a monochrome terminal too.
  const passed = report.summary.passed > 0;
  const line = `${passed ? "✓" : "·"} ${inspected} · ${apps}`;
  output.write(`${passed ? context.style.green(line) : line}\n`);
}

function renderRecommendation(
  report: CheckReport,
  branding: CliBranding,
  output: Writable,
  context: HumanRenderContext,
): void {
  if (report.status === "operational-error") {
    return;
  }
  const fixable = report.findings.filter((finding) => finding.fixability !== "manual");
  if (fixable.length === 0) {
    return;
  }
  const automatic = fixable.filter((finding) => finding.fixability === "auto").length;
  const guided = fixable.length - automatic;
  const command = `${branding.command} check --fix${guided > 0 ? " --interactive" : ""}`;
  const modes = [
    ...(automatic > 0 ? [`${String(automatic)} automatic`] : []),
    ...(guided > 0 ? [`${String(guided)} guided`] : []),
  ];
  renderSection(
    "▶",
    "Recommended next step",
    [
      command,
      `Review ${String(fixable.length)} available ${pluralize(fixable.length, "fix", "fixes")}: ${modes.join(" · ")}.`,
      "Aura previews every change before writing and checks your setup again afterward.",
    ],
    output,
    context.style.bold,
  );
}

function renderDiagnostics(
  report: CheckReport,
  output: Writable,
  context: HumanRenderContext,
): void {
  if (report.diagnostics.length === 0) {
    return;
  }
  renderSection(
    "✗",
    `Run errors (${String(report.diagnostics.length)})`,
    [
      ...report.diagnostics.flatMap((diagnostic) => [
        `${safe(diagnostic.message)} ${context.style.dim(`[${safe(diagnostic.id)}:${diagnostic.phase}]`)}`,
        ...(diagnostic.detail === undefined ? [] : [`  ${safe(diagnostic.detail)}`]),
      ]),
      "The scan is incomplete, so Aura will not recommend applying fixes from this result.",
    ],
    output,
    context.style.red,
  );
}

function renderInventory(
  report: CheckReport,
  branding: CliBranding,
  output: Writable,
  context: HumanRenderContext,
): void {
  if (report.passedChecks.length > 0) {
    renderSection(
      "✓",
      `Passed checks (${String(report.passedChecks.length)})`,
      report.passedChecks.map(
        (check) => `${safe(check.title)} ${context.style.dim(`[${safe(check.id)}]`)}`,
      ),
      output,
      context.style.green,
    );
  }
  const detected = report.apps.filter((app) => app.detection.installed);
  if (detected.length > 0) {
    renderSection("·", `Detected (${String(detected.length)})`, detected.map(detectedLine), output);
  }
  const missing = report.apps.filter((app) => !app.detection.installed);
  if (missing.length > 0) {
    renderSection(
      "·",
      `Not found (${String(missing.length)})`,
      [
        ...missing.map((app) => notFoundLine(app.displayName, app.detectionScope)),
        `Run ${branding.command} setup to install and manage any of them`,
      ],
      output,
    );
  }
}

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
  return app.support.status === "unsupported"
    ? `unsupported (supports ${safe(app.support.supportedRange)})`
    : "supported";
}

function renderSection(
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

function countPhrase(count: number, noun: string): string {
  return `${String(count)} ${pluralize(count, noun)}`;
}

function humanVerdict(report: CheckReport): string {
  switch (report.status) {
    case "clean":
      return "all clear";
    case "warning":
      return "attention recommended";
    case "error":
      return "action required";
    case "operational-error":
      return "check incomplete";
    case "empty":
      return "nothing checked";
  }
}

function resultLine(report: CheckReport): string {
  return `Result: ${humanVerdict(report)} (exit ${String(report.summary.exitCode)})`;
}

function verdictStyle(report: CheckReport, style: Style): (text: string) => string {
  if (report.status === "clean") {
    return style.green;
  }
  return report.status === "warning" || report.status === "empty" ? style.yellow : style.red;
}

function hasHiddenDetail(report: CheckReport, checks: ReadonlyMap<string, Check>): boolean {
  return (
    report.passedChecks.length > 0 ||
    report.apps.length > 0 ||
    findingsHaveHiddenDetail(report.findings, checks)
  );
}
