import type { Check, Severity } from "@tryaura/aura-sdk";
import { displayPath, type PathDisplayRoots } from "@tryaura/core/display-path";

import { highestSeverity, severityRank } from "./render-human-findings.js";
import type { ReportApp, ReportFinding } from "./report-shapes.js";
import { safeFindingText } from "./safe-text.js";

type SubjectKind = "app" | "check" | "path";

export interface SubjectCounts {
  readonly errors: number;
  readonly informational: number;
  readonly warnings: number;
}

export interface ReportSubject {
  /** The members the human ceiling kept, in the order they will render. */
  readonly findings: readonly ReportFinding[];
  readonly key: string;
  readonly kind: SubjectKind;
  readonly label: string;
  readonly shown: SubjectCounts;
  /** Every member the run found, so a heading truncated by the ceiling can name both numbers. */
  readonly total: SubjectCounts;
}

export interface SubjectRequest {
  readonly all: readonly ReportFinding[];
  readonly apps: readonly ReportApp[];
  readonly checks: ReadonlyMap<string, Check>;
  readonly roots: PathDisplayRoots;
  readonly shown: readonly ReportFinding[];
}

/**
 * The findings of a run, gathered under the thing each one is about.
 *
 * Subjects are built from every finding rather than only the shown ones so a heading can report
 * what the run found even where the ceiling truncated what it prints — a subject that named only
 * the survivors would quietly disagree with the severity counts in the headline above it.
 */
export function reportSubjects(request: SubjectRequest): readonly ReportSubject[] {
  const installed = new Map(
    request.apps.filter((app) => app.detection.installed).map((app) => [app.appId, app]),
  );
  const shownIds = new Set(request.shown.map((finding) => finding.findingId));
  const order = new Map(request.shown.map((finding, index) => [finding.findingId, index]));
  const gathered = new Map<string, { identity: SubjectIdentity; members: ReportFinding[] }>();

  for (const finding of request.all) {
    const identity = subjectOf(finding, installed, request.checks, request.roots);
    const existing = gathered.get(identity.key);
    if (existing === undefined) {
      gathered.set(identity.key, { identity, members: [finding] });
      continue;
    }
    existing.members.push(finding);
  }

  return [...gathered.values()]
    .map(({ identity, members }) => ({
      ...identity,
      findings: members
        .filter((finding) => shownIds.has(finding.findingId))
        .sort((left, right) => rank(order, left) - rank(order, right)),
      shown: countBySeverity(members.filter((finding) => shownIds.has(finding.findingId))),
      total: countBySeverity(members),
    }))
    .filter((subject) => subject.findings.length > 0)
    .sort(compareSubjects);
}

interface SubjectIdentity {
  readonly key: string;
  readonly kind: SubjectKind;
  readonly label: string;
}

/**
 * What one finding is about, derived because a finding carries no first-class subject.
 *
 * The `appId` is plugin-supplied and therefore untrusted, so it is honoured only when it names an
 * application this scan actually detected — and then the adapter's own display name renders, not
 * the plugin's string. Anything unrecognized falls through to a location, which is shortened and
 * sanitized like every other path the report prints.
 */
function subjectOf(
  finding: ReportFinding,
  installed: ReadonlyMap<string, ReportApp>,
  checks: ReadonlyMap<string, Check>,
  roots: PathDisplayRoots,
): SubjectIdentity {
  const appId = finding.metadata?.["appId"];
  const app = typeof appId === "string" ? installed.get(appId) : undefined;
  if (app !== undefined) {
    return { key: `app:${app.appId}`, kind: "app", label: safeFindingText(app.displayName) };
  }
  // The first location, never all of them: a finding filed under two subjects would be counted
  // twice, and the subject totals would stop summing to the headline they sit beneath.
  const path = finding.locations?.[0]?.path;
  if (path !== undefined) {
    return { key: `path:${path}`, kind: "path", label: safeFindingText(displayPath(path, roots)) };
  }
  const title = checks.get(finding.checkId)?.title ?? finding.checkId;
  return { key: `check:${finding.checkId}`, kind: "check", label: safeFindingText(title) };
}

/**
 * Worst first, then largest, then by label.
 *
 * The label tiebreak compares code units rather than collating, because a report that reordered
 * itself with the machine's locale would make two runs of the same scan impossible to diff.
 */
function compareSubjects(left: ReportSubject, right: ReportSubject): number {
  const severity = severityRank(subjectSeverity(left)) - severityRank(subjectSeverity(right));
  if (severity !== 0) {
    return severity;
  }
  const size = right.findings.length - left.findings.length;
  return size === 0 ? compareText(left.label, right.label) : size;
}

function subjectSeverity(subject: ReportSubject): Severity {
  return highestSeverity(subject.findings);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rank(order: ReadonlyMap<string, number>, finding: ReportFinding): number {
  return order.get(finding.findingId) ?? 0;
}

function countBySeverity(findings: readonly ReportFinding[]): SubjectCounts {
  return {
    errors: findings.filter((finding) => finding.severity === "error").length,
    informational: findings.filter((finding) => finding.severity === "info").length,
    warnings: findings.filter((finding) => finding.severity === "warn").length,
  };
}
