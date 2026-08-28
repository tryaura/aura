import type { OutcomeCount, RepoSessionAggregate, SessionAnalysis } from "@tryaura/core";

import { count, percent, ratio } from "./chart.js";
import { hasCompactionPressure, hasNeverGreenPressure } from "./health.js";
import { displayProject } from "./render-row.js";
import { safe } from "../safe-text.js";

/**
 * The `Needs attention` findings: one line per thing worth acting on, not one block per project.
 *
 * Most non-success tool outcomes are ordinary agent work — a grep with no hits inside a batch, a
 * test run the agent expected to fail — so raw counts and low-confidence `unknown_nonzero` exits
 * never make a finding on their own. A finding needs either high-confidence evidence (a missing
 * executable) or a deviation: a failure rate far above the rest of the window, sessions that ran
 * validation and never passed, or repeated context-window overruns.
 */

/** Confirmed environment failures start mattering here; below, they read as one-off noise. */
const TOOL_ERROR_THRESHOLD = 3;
/** Confirmed failures must also be a visible share of the project's calls, not a rounding error. */
const TOOL_ERROR_RATE_FLOOR = 0.01;
/** A rate comparison needs volume before it means anything. */
const OUTLIER_PROBLEM_THRESHOLD = 10;
const OUTLIER_RATE_FLOOR = 0.05;
const OUTLIER_BASELINE_MULTIPLE = 2;
const DISPLAYED_BATCH_COMPONENTS = 3;

export function attentionFindings(analysis: SessionAnalysis, homeDir: string): readonly string[] {
  return [
    ...missingExecutableFindings(analysis, homeDir),
    ...failureOutlierFindings(analysis, homeDir),
    ...neverGreenFindings(analysis, homeDir),
    ...compactionFindings(analysis, homeDir),
  ];
}

/** Exit-127 outcomes grouped by executable across the whole window: fix once, not per project. */
function missingExecutableFindings(analysis: SessionAnalysis, homeDir: string): readonly string[] {
  const byLabel = new Map<string, { calls: number; firstProject: string; projects: Set<string> }>();
  for (const repo of analysis.repos) {
    for (const outcome of repo.invocationErrorCounts) {
      const project = displayProject(repo.project, homeDir);
      const entry = byLabel.get(outcome.label) ?? {
        calls: 0,
        firstProject: project,
        projects: new Set<string>(),
      };
      entry.calls += outcome.count;
      entry.projects.add(project);
      byLabel.set(outcome.label, entry);
    }
  }
  return [...byLabel.entries()]
    .sort(([leftLabel, left], [rightLabel, right]) => {
      return right.calls - left.calls || leftLabel.localeCompare(rightLabel);
    })
    .map(([label, entry]) => {
      const name = label === "shell batch" ? "a shell-batch command" : safe(label);
      const where =
        entry.projects.size === 1
          ? `in ${entry.firstProject}`
          : `across ${count(entry.projects.size, "project")}`;
      return `${name} not found (exit 127) — ${count(entry.calls, "failing call")} ${where} · install it or fix the instructions that call it`;
    });
}

interface FailureProfile {
  readonly problems: number;
  readonly rate: number;
  readonly repo: RepoSessionAggregate;
  readonly toolErrors: number;
}

/** Projects whose failure rate stands out against the rest of the window, worst first. */
function failureOutlierFindings(analysis: SessionAnalysis, homeDir: string): readonly string[] {
  const profiles = analysis.repos.map(failureProfile);
  const totals = profiles.reduce(
    (sum, profile) => ({
      calls: sum.calls + profile.repo.toolCalls,
      problems: sum.problems + profile.problems,
    }),
    { calls: 0, problems: 0 },
  );
  return profiles
    .map((profile) => ({
      baseline: ratio(totals.problems - profile.problems, totals.calls - profile.repo.toolCalls),
      profile,
    }))
    .filter(({ baseline, profile }) => isFailureOutlier(profile, baseline))
    .sort((left, right) => right.profile.rate - left.profile.rate)
    .map(({ baseline, profile }) => outlierText(profile, baseline, homeDir));
}

function failureProfile(repo: RepoSessionAggregate): FailureProfile {
  const toolErrors = Math.max(0, repo.operationalFailures - repo.invocationErrors);
  const problems = toolErrors + repo.unknownOutcomes;
  return { problems, rate: ratio(problems, repo.toolCalls), repo, toolErrors };
}

function isFailureOutlier(profile: FailureProfile, baseline: number): boolean {
  if (
    profile.toolErrors >= TOOL_ERROR_THRESHOLD &&
    ratio(profile.toolErrors, profile.repo.toolCalls) >= TOOL_ERROR_RATE_FLOOR
  ) {
    return true;
  }
  return (
    profile.problems >= OUTLIER_PROBLEM_THRESHOLD &&
    profile.rate >= Math.max(OUTLIER_RATE_FLOOR, baseline * OUTLIER_BASELINE_MULTIPLE)
  );
}

function outlierText(profile: FailureProfile, baseline: number, homeDir: string): string {
  const fleet = baseline > 0 ? ` · fleet rate ${percent(baseline)}` : "";
  const worst = profile.repo.outcomeCounts.find(
    (outcome) => outcome.kind === "tool_error" || outcome.kind === "unknown_nonzero",
  );
  const worstPart = worst === undefined ? "" : ` · worst: ${safe(worst.label)} ×${worst.count}`;
  const components = worst === undefined ? "" : batchComponentText(worst);
  return `${displayProject(profile.repo.project, homeDir)} — ${percent(profile.rate)} of ${count(profile.repo.toolCalls, "tool call")} failed${fleet}${worstPart}${components}`;
}

/** Component counts describe what the failed batch contained, never which segment failed. */
function batchComponentText(outcome: OutcomeCount): string {
  if (outcome.label !== "shell batch" || outcome.batchComponents === undefined) {
    return "";
  }
  const shown = outcome.batchComponents.slice(0, DISPLAYED_BATCH_COMPONENTS);
  const labels = shown.map((component) => {
    const identity =
      component.subcommand === undefined
        ? component.command
        : `${component.command} ${component.subcommand}`;
    return `${safe(identity)} ×${component.count}`;
  });
  const omitted = Math.max(0, (outcome.batchComponentCount ?? shown.length) - shown.length);
  const rest = omitted === 0 ? "" : `, +${omitted} more`;
  return labels.length === 0 ? "" : ` · contains: ${labels.join(", ")}${rest}`;
}

/** Sessions that ran validation and never recorded a green run likely left work unfinished. */
function neverGreenFindings(analysis: SessionAnalysis, homeDir: string): readonly string[] {
  return analysis.repos
    .filter(hasNeverGreenPressure)
    .sort((left, right) => right.neverGreenSessions - left.neverGreenSessions)
    .map(
      (repo) =>
        `${displayProject(repo.project, homeDir)} — ${count(repo.neverGreenSessions, "session")} ran validation and never saw it pass`,
    );
}

function compactionFindings(analysis: SessionAnalysis, homeDir: string): readonly string[] {
  return analysis.repos
    .filter(hasCompactionPressure)
    .sort(
      (left, right) =>
        ratio(right.compactions, right.sessions) - ratio(left.compactions, left.sessions),
    )
    .map(
      (repo) =>
        `${displayProject(repo.project, homeDir)} — ${count(repo.compactions, "compaction")} across ${count(repo.sessions, "session")} · work repeatedly outgrew the context window`,
    );
}
