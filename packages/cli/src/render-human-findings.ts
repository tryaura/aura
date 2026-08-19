import type { Writable } from "node:stream";

import type { Check, Severity } from "@tryaura/aura-sdk";
import { pluralize } from "@tryaura/core/pluralize";

import { renderFindingPresentation } from "./metadata-table.js";
import { locationText } from "./render-human-path.js";
import type { HumanRenderContext } from "./render-human-types.js";
import type { ReportFinding } from "./report-shapes.js";
import { safe, safeFindingText } from "./safe-text.js";
import type { Style } from "./style.js";

/**
 * What a concise group prints before it summarizes the rest.
 *
 * A group exists to state one remediation once, not to hide which files need it: members selected
 * within the report's human-output budget are named because a count alone cannot tell a user which
 * credential leaked or which file to open. Only the concise tail waits for `--verbose`.
 */
const CONCISE_OCCURRENCES = 3;
const CONCISE_LOCATIONS = 2;
const MAX_HUMAN_FINDINGS = 100;
const MAX_HUMAN_LOCATIONS = 100;
/** Highest severity first; findings of equal severity keep the order their plugins reported. */
const SEVERITY_ORDER = ["error", "warn", "info"] as const satisfies readonly Severity[];

/**
 * The remediation sections, in the order a reader should act on them.
 *
 * The three matchers are exhaustive over any finding, so no severity or fixability can fall
 * between them and go unreported.
 */
export const FINDING_SECTIONS: readonly {
  readonly match: (finding: ReportFinding) => boolean;
  readonly title: string;
}[] = [
  { match: (finding) => finding.fixability !== "manual", title: "Available fixes" },
  {
    match: (finding) => finding.fixability === "manual" && finding.severity !== "info",
    title: "Manual attention",
  },
  {
    match: (finding) => finding.fixability === "manual" && finding.severity === "info",
    title: "Suggestions",
  },
];

interface FindingGroup {
  readonly description?: string | undefined;
  readonly findings: ReportFinding[];
  readonly title?: string | undefined;
}

/**
 * One remediation section, counting both what it shows and what the run actually found.
 *
 * The two numbers only diverge once the ceiling truncates, and there they have to appear together:
 * the recommended next step speaks for every finding in the run, so a heading that quoted only the
 * shown count would read as a contradiction of the command directly above it.
 */
export function renderFindingSection(
  title: string,
  findings: readonly ReportFinding[],
  total: number,
  checks: ReadonlyMap<string, Check>,
  output: Writable,
  context: HumanRenderContext,
): void {
  if (findings.length === 0) {
    return;
  }
  const count =
    total > findings.length ? `${String(findings.length)} of ${String(total)}` : String(total);
  output.write(`\n${title} (${count})\n`);
  for (const group of findingGroups(findings, checks)) {
    renderFindingGroup(group, output, context);
  }
}

/** Whether `--verbose` would add anything these findings do not already show. */
export function findingsHaveHiddenDetail(
  findings: readonly ReportFinding[],
  checks: ReadonlyMap<string, Check>,
): boolean {
  return findings.some(
    (finding) =>
      finding.presentation !== undefined ||
      (finding.locations?.length ?? 0) > CONCISE_LOCATIONS ||
      checks.get(finding.checkId)?.findingGroup !== undefined,
  );
}

/**
 * The findings human output renders: severity-first, bounded by the report's own safety ceiling.
 *
 * Bucketing rather than sorting keeps the selection linear in the number of findings, which is the
 * case the ceiling exists for — a report large enough to need truncating is the last one that
 * should pay to order the part nobody will read.
 */
export function humanFindings(findings: readonly ReportFinding[]): readonly ReportFinding[] {
  return findingsBySeverity(findings).slice(0, MAX_HUMAN_FINDINGS);
}

/** Whether the ceilings dropped detail that no flag on the human report can bring back. */
export function findingsExceedHumanLimits(findings: readonly ReportFinding[]): boolean {
  return (
    findings.length > MAX_HUMAN_FINDINGS ||
    findings.some((finding) => (finding.locations?.length ?? 0) > MAX_HUMAN_LOCATIONS)
  );
}

function findingsBySeverity(findings: readonly ReportFinding[]): readonly ReportFinding[] {
  return SEVERITY_ORDER.flatMap((severity) =>
    findings.filter((finding) => finding.severity === severity),
  );
}

function findingGroups(
  findings: readonly ReportFinding[],
  checks: ReadonlyMap<string, Check>,
): readonly FindingGroup[] {
  const ordered = findingsBySeverity(findings);
  const groups = new Map<string, FindingGroup>();
  for (const [index, finding] of ordered.entries()) {
    const presentation = checks.get(finding.checkId)?.findingGroup;
    const key = presentation?.id ?? `finding:${String(index)}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        ...(presentation === undefined
          ? {}
          : { description: presentation.description, title: presentation.title }),
        findings: [finding],
      });
      continue;
    }
    existing.findings.push(finding);
  }
  return [...groups.values()];
}

/**
 * One remediation, whether it came from a declared group or a lone finding.
 *
 * A grouped heading always carries its count, even at one member: the same group splits across
 * remediation sections when its findings differ in fixability, and a heading that changed shape
 * with the count would make the two halves look like unrelated problems.
 */
function renderFindingGroup(
  group: FindingGroup,
  output: Writable,
  context: HumanRenderContext,
): void {
  const first = group.findings[0];
  if (first === undefined) {
    return;
  }
  const severity = highestSeverity(group.findings);
  const heading =
    group.title === undefined
      ? safeFindingText(first.message)
      : `${safeFindingText(group.title)} (${String(group.findings.length)})`;
  output.write(
    `\n  ${severityStyle(severity, context.style)(`${severitySymbol(severity)} ${heading}`)}\n`,
  );

  if (group.title === undefined) {
    renderFindingBody(first, output, context, "    ");
  } else {
    if (group.description !== undefined) {
      output.write(`    ${safeFindingText(group.description)}\n`);
    }
    renderOccurrences(group.findings, output, context);
  }
  renderCheckIds(group.findings, output, context.style);
}

/** Every member of a declared group, named individually under the shared remediation. */
function renderOccurrences(
  findings: readonly ReportFinding[],
  output: Writable,
  context: HumanRenderContext,
): void {
  const shown = context.options.verbose ? findings : findings.slice(0, CONCISE_OCCURRENCES);
  for (const finding of shown) {
    const decorate = severityStyle(finding.severity, context.style);
    output.write(
      `    ${decorate(`${severitySymbol(finding.severity)} ${safeFindingText(finding.message)}`)}\n`,
    );
    renderFindingBody(finding, output, context, "      ");
  }
  const hidden = findings.length - shown.length;
  if (hidden > 0) {
    output.write(`    +${String(hidden)} more ${pluralize(hidden, "occurrence")}\n`);
  }
}

function renderFindingBody(
  finding: ReportFinding,
  output: Writable,
  context: HumanRenderContext,
  indent: string,
): void {
  if (finding.details !== undefined) {
    output.write(`${indent}${safeFindingText(finding.details)}\n`);
  }
  const locations = finding.locations ?? [];
  const limit = context.options.verbose ? MAX_HUMAN_LOCATIONS : CONCISE_LOCATIONS;
  const shown = locations.slice(0, limit);
  for (const location of shown) {
    output.write(`${indent}${locationText(location, context.options)}\n`);
  }
  const hidden = locations.length - shown.length;
  if (hidden > 0) {
    output.write(`${indent}+${String(hidden)} more ${pluralize(hidden, "location")}\n`);
  }
  if (context.options.verbose) {
    for (const line of renderFindingPresentation(finding)) {
      output.write(`${indent}${line}\n`);
    }
  }
}

function renderCheckIds(findings: readonly ReportFinding[], output: Writable, style: Style): void {
  const ids = [...new Set(findings.map((finding) => safe(finding.checkId)))];
  const label = ids.length === 1 ? "Check" : "Checks";
  output.write(`    ${style.dim(`${label}: ${ids.join(", ")}`)}\n`);
}

function highestSeverity(findings: readonly ReportFinding[]): Severity {
  return findings.reduce<Severity>(
    (highest, finding) =>
      severityRank(finding.severity) < severityRank(highest) ? finding.severity : highest,
    "info",
  );
}

function severityRank(severity: Severity): number {
  return severity === "error" ? 0 : severity === "warn" ? 1 : 2;
}

function severitySymbol(severity: Severity): string {
  return severity === "error" ? "✗" : severity === "warn" ? "!" : "·";
}

function severityStyle(severity: Severity, style: Style): (text: string) => string {
  return severity === "error" ? style.red : severity === "warn" ? style.yellow : (text) => text;
}
