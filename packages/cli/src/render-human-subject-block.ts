import type { Writable } from "node:stream";

import type { Check } from "@tryaura/aura-sdk";
import { pluralize } from "@tryaura/core/pluralize";

import { renderFindingPresentation } from "./metadata-table.js";
import {
  CONCISE_LOCATIONS,
  CONCISE_OCCURRENCES,
  findingGroups,
  highestSeverity,
  MAX_HUMAN_LOCATIONS,
  severityStyle,
  severitySymbol,
  type FindingGroup,
} from "./render-human-findings.js";
import { pinnedRow } from "./render-human-layout.js";
import { locationText } from "./render-human-path.js";
import type { ReportSubject, SubjectCounts } from "./render-human-subject.js";
import type { HumanRenderContext } from "./render-human-types.js";
import type { ReportApp, ReportFinding } from "./report-shapes.js";
import { safe, safeFindingText } from "./safe-text.js";

/**
 * One subject and everything the run found about it.
 *
 * The heading carries the counts rather than a verdict glyph: a subject is a place, not a problem,
 * and what a reader needs from it first is how much of their attention it is asking for.
 */
export function renderSubject(
  subject: ReportSubject,
  checks: ReadonlyMap<string, Check>,
  output: Writable,
  context: HumanRenderContext,
): void {
  output.write("\n");
  for (const line of pinnedRow({
    decorate: context.style.bold,
    indent: "",
    pinned: context.style.dim(countsText(subject)),
    text: subject.label,
    width: context.columns,
  })) {
    output.write(`${line}\n`);
  }
  for (const group of findingGroups(subject.findings, checks)) {
    renderFindingGroup(group, subject.label, output, context);
  }
}

/**
 * A detected application the run found nothing to say about.
 *
 * These close the list so the report states the condition of the machine rather than only its
 * problems — a reader who fixed something wants to see it named as settled, not merely absent.
 */
export function renderSettledApp(
  app: ReportApp,
  output: Writable,
  context: HumanRenderContext,
): void {
  const version = app.detection.version === undefined ? "" : ` ${safe(app.detection.version)}`;
  for (const line of pinnedRow({
    decorate: context.style.green,
    indent: "",
    text: `✓ ${safe(app.displayName)}${version} — no findings`,
    width: context.columns,
  })) {
    output.write(`${line}\n`);
  }
}

/**
 * One remediation, whether it came from a declared group or a lone finding.
 *
 * A grouped heading always carries its count, even at one member: the same group can appear under
 * two subjects when its findings span two applications, and a heading that changed shape with the
 * count would make the two look like unrelated problems.
 */
function renderFindingGroup(
  group: FindingGroup,
  subjectLabel: string,
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
  const ids = [...new Set(group.findings.map((finding) => safe(finding.checkId)))];
  const metadata =
    group.title === undefined ? `${ids.join(", ")} · ${fixabilityText(first)}` : ids.join(", ");

  writeLines(
    output,
    pinnedRow({
      continuationIndent: "    ",
      decorate: severityStyle(severity, context.style),
      indent: "  ",
      pinned: context.style.dim(metadata),
      text: `${severitySymbol(severity)} ${heading}`,
      width: context.columns,
    }),
  );

  if (group.title === undefined) {
    renderFindingBody(first, subjectLabel, output, context, "    ");
    return;
  }
  if (group.description !== undefined) {
    writeWrapped(output, safeFindingText(group.description), "    ", context);
  }
  renderOccurrences(group.findings, subjectLabel, output, context);
}

/** Every member of a declared group, named individually under the shared remediation. */
function renderOccurrences(
  findings: readonly ReportFinding[],
  subjectLabel: string,
  output: Writable,
  context: HumanRenderContext,
): void {
  const shown = context.options.verbose ? findings : findings.slice(0, CONCISE_OCCURRENCES);
  for (const finding of shown) {
    writeLines(
      output,
      pinnedRow({
        continuationIndent: "      ",
        decorate: severityStyle(finding.severity, context.style),
        indent: "    ",
        pinned: context.style.dim(fixabilityText(finding)),
        text: `${severitySymbol(finding.severity)} ${safeFindingText(finding.message)}`,
        width: context.columns,
      }),
    );
    renderFindingBody(finding, subjectLabel, output, context, "      ");
  }
  const hidden = findings.length - shown.length;
  if (hidden > 0) {
    output.write(`    +${String(hidden)} more ${pluralize(hidden, "occurrence")}\n`);
  }
}

/** The capability this occurrence actually offers, including a per-finding manual downgrade. */
function fixabilityText(finding: ReportFinding): string {
  return finding.fixability === "auto" ? "automatic" : finding.fixability;
}

function renderFindingBody(
  finding: ReportFinding,
  subjectLabel: string,
  output: Writable,
  context: HumanRenderContext,
  indent: string,
): void {
  if (finding.details !== undefined) {
    writeWrapped(output, safeFindingText(finding.details), indent, context);
  }
  const locations = finding.locations ?? [];
  const limit = context.options.verbose ? MAX_HUMAN_LOCATIONS : CONCISE_LOCATIONS;
  const shown = locations.slice(0, limit);
  for (const location of shown) {
    // A location that only repeats the heading it sits under says nothing the reader has not just
    // read; a location that adds a line or a second file still earns its line.
    const text = locationText(location, context.options);
    if (text !== subjectLabel) {
      writeWrapped(output, text, indent, context);
    }
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

/**
 * The severity counts a heading carries, naming both numbers wherever the ceiling truncated.
 *
 * A severity absent from the run is absent from the heading: a subject holding two warnings has
 * nothing useful to say about the errors it does not have.
 */
function countsText(subject: ReportSubject): string {
  const parts: string[] = [];
  for (const [key, noun] of COUNT_NOUNS) {
    if (subject.total[key] > 0) {
      parts.push(countPhrase(subject.shown[key], subject.total[key], noun));
    }
  }
  return parts.join(" · ");
}

const COUNT_NOUNS = [
  ["errors", "error"],
  ["warnings", "warning"],
  ["informational", "suggestion"],
] as const satisfies readonly (readonly [keyof SubjectCounts, string])[];

function countPhrase(shown: number, total: number, noun: string): string {
  const whole = `${String(total)} ${pluralize(total, noun)}`;
  return shown < total ? `${String(shown)} of ${whole}` : whole;
}

function writeWrapped(
  output: Writable,
  text: string,
  indent: string,
  context: HumanRenderContext,
): void {
  writeLines(output, pinnedRow({ indent, text, width: context.columns }));
}

function writeLines(output: Writable, lines: readonly string[]): void {
  for (const line of lines) {
    output.write(`${line}\n`);
  }
}
