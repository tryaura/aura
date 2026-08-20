import type { Check, Severity } from "@tryaura/aura-sdk";

import type { ReportFinding } from "./report-shapes.js";
import type { Style } from "./style.js";

/**
 * What a concise group prints before it summarizes the rest.
 *
 * A group exists to state one remediation once, not to hide which files need it: members selected
 * within the report's human-output budget are named because a count alone cannot tell a user which
 * credential leaked or which file to open. Only the concise tail waits for `--verbose`.
 */
export const CONCISE_OCCURRENCES = 3;
export const CONCISE_LOCATIONS = 2;
export const MAX_HUMAN_LOCATIONS = 100;
const MAX_HUMAN_FINDINGS = 100;
/** Highest severity first; findings of equal severity keep the order their plugins reported. */
const SEVERITY_ORDER = ["error", "warn", "info"] as const satisfies readonly Severity[];

export interface FindingGroup {
  readonly description?: string | undefined;
  readonly findings: ReportFinding[];
  readonly title?: string | undefined;
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
 * should pay to order the part nobody will read. Selection runs before subjects are gathered, so a
 * subject can hold fewer findings than it counts and has to report both numbers.
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

/**
 * One subject's findings, gathered under the remediations their checks declared.
 *
 * Grouping happens within a subject rather than across the report, so a group whose members span
 * two applications states its remediation once under each — the reader is being told what to do in
 * a specific file, and a heading gathered from elsewhere would name files they are not looking at.
 */
export function findingGroups(
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

export function highestSeverity(findings: readonly ReportFinding[]): Severity {
  return findings.reduce<Severity>(
    (highest, finding) =>
      severityRank(finding.severity) < severityRank(highest) ? finding.severity : highest,
    "info",
  );
}

export function severityRank(severity: Severity): number {
  return severity === "error" ? 0 : severity === "warn" ? 1 : 2;
}

export function severitySymbol(severity: Severity): string {
  return severity === "error" ? "✗" : severity === "warn" ? "!" : "·";
}

export function severityStyle(severity: Severity, style: Style): (text: string) => string {
  return severity === "error" ? style.red : severity === "warn" ? style.yellow : (text) => text;
}
