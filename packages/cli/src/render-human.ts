import type { Writable } from "node:stream";

import type { Check } from "@tryaura/aura-sdk";
import { pluralize } from "@tryaura/core/pluralize";

import { notFoundLine } from "./not-found-line.js";
import {
  findingsExceedHumanLimits,
  findingsHaveHiddenDetail,
  humanFindings,
} from "./render-human-findings.js";
import { pinnedRow, reportColumns } from "./render-human-layout.js";
import { renderSettledApp, renderSubject } from "./render-human-subject-block.js";
import { reportSubjects } from "./render-human-subject.js";
import type { HumanCheckRenderOptions, HumanRenderContext } from "./render-human-types.js";
import type { CheckReport } from "./report.js";
import type { ReportApp, ReportFinding } from "./report-shapes.js";
import { safe } from "./safe-text.js";
import { createStyle, type Style } from "./style.js";
import type { CliBranding } from "./types.js";

export function renderHumanCheckReport(
  report: CheckReport,
  branding: CliBranding,
  output: Writable,
  options: HumanCheckRenderOptions,
): void {
  const context = {
    columns: reportColumns(output),
    options,
    style: createStyle(options.colorDepth),
  };
  output.write(`${branding.displayName} check — ${humanVerdict(report)}\n`);
  renderHeadline(report, output, context);

  if (options.notes.length > 0) {
    renderSection("·", "Configuration", options.notes.map(safe), output);
  }

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
  const shown = humanFindings(report.findings);
  const subjects = reportSubjects({
    all: report.findings,
    apps: report.apps,
    checks,
    roots: options.roots,
    shown,
  });
  for (const subject of subjects) {
    renderSubject(subject, checks, output, context);
  }
  renderSettled(report, output, context);

  const hidden = report.findings.length - shown.length;
  if (hidden > 0) {
    output.write(`\n… and ${String(hidden)} more ${pluralize(hidden, "finding")} not shown\n`);
  }

  if (options.verbose) {
    renderInventory(report, branding, output, context);
  }
  renderMore(report, branding, output, context, shown, checks);
  output.write(`\n${resultLine(report, context.style)}\n`);
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
  shown: readonly ReportFinding[],
  checks: ReadonlyMap<string, Check>,
): void {
  const lines: string[] = [];
  if (report.findings.length > 0) {
    lines.push(`Explain any check: ${branding.command} check --explain <id>`);
  }
  // Only what `--verbose` will actually reach counts: detail on a finding the ceiling already
  // dropped is not something the flag can show, so offering it there would be a dead end.
  if (!context.options.verbose && hasHiddenDetail(report, shown, checks)) {
    lines.push(
      `Expand occurrences and locations; add passed checks: ${branding.command} check --verbose`,
    );
  }
  if (findingsExceedHumanLimits(report.findings)) {
    lines.push(`Show every finding without human output limits: ${branding.command} check --json`);
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

/**
 * The one command that addresses every fixable finding, on one line.
 *
 * The split between automatic and guided is what tells the user whether the run will stop to ask
 * them anything, so it travels with the command rather than in prose below it. Where the terminal
 * cannot hold both, the summary wraps beneath instead of the command losing its place.
 */
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
  const modes = [
    ...(automatic > 0 ? [`${String(automatic)} automatic`] : []),
    ...(guided > 0 ? [`${String(guided)} guided`] : []),
  ];
  const command = `▶ ${branding.command} check --fix`;
  const summary = `${String(fixable.length)} ${pluralize(fixable.length, "fix", "fixes")}: ${modes.join(" · ")}, previewed first`;

  output.write("\n");
  for (const line of pinnedRow({
    decorate: context.style.bold,
    indent: "",
    pinned: context.style.dim(summary),
    text: command,
    width: context.columns,
  })) {
    output.write(`${line}\n`);
  }
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

/** Detected applications no finding spoke for, closing the list as settled. */
function renderSettled(report: CheckReport, output: Writable, context: HumanRenderContext): void {
  // The human ceiling may remove every visible finding for one application. Derive this from the
  // complete report so an omitted subject can never turn into a green "no findings" claim.
  const affected = new Set<string>();
  for (const finding of report.findings) {
    const appId = finding.metadata?.["appId"];
    if (typeof appId === "string") {
      affected.add(appId);
    }
  }
  const settled = report.apps.filter((app) => app.detection.installed && !affected.has(app.appId));
  if (settled.length === 0) {
    return;
  }
  output.write("\n");
  for (const app of settled) {
    renderSettledApp(app, output, context);
  }
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
  const missing = report.apps.filter((app) => !app.detection.installed);
  if (missing.length > 0) {
    renderSection(
      "·",
      `Not found (${String(missing.length)})`,
      [
        ...missing.map((app: ReportApp) => notFoundLine(app.displayName, app.detectionScope)),
        `Run ${branding.command} setup to install and manage any of them`,
      ],
      output,
    );
  }
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

function resultLine(report: CheckReport, style: Style): string {
  const decorateVerdict = verdictStyle(report, style);
  const decorateExit = report.summary.exitCode === 0 ? style.green : decorateVerdict;
  return `${decorateVerdict(`Result: ${humanVerdict(report)}`)} (${decorateExit(`exit ${String(report.summary.exitCode)}`)})`;
}

function verdictStyle(report: CheckReport, style: Style): (text: string) => string {
  if (report.status === "clean") {
    return style.green;
  }
  return report.status === "operational-error" ? style.red : style.yellow;
}

function hasHiddenDetail(
  report: CheckReport,
  shown: readonly ReportFinding[],
  checks: ReadonlyMap<string, Check>,
): boolean {
  return report.passedChecks.length > 0 || findingsHaveHiddenDetail(shown, checks);
}
