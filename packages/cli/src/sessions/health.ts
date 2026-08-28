import type { RepoSessionAggregate } from "@tryaura/core";

const FAILURE_COUNT_THRESHOLD = 3;
const FAILURE_RATE_THRESHOLD = 0.05;
const COMPACTION_RATE_THRESHOLD = 0.5;
/** One session that never went green is routine iteration; a pattern starts at two. */
const NEVER_GREEN_THRESHOLD = 2;

/** Outcomes that may indicate an execution problem; ordinary check failures stay separate. */
export function toolProblemCount(repo: RepoSessionAggregate): number {
  return repo.operationalFailures + repo.unknownOutcomes;
}

function hasMaterialToolProblems(repo: RepoSessionAggregate): boolean {
  const problems = toolProblemCount(repo);
  return (
    problems >= FAILURE_COUNT_THRESHOLD ||
    (problems > 0 && problems >= repo.toolCalls * FAILURE_RATE_THRESHOLD)
  );
}

export function hasCompactionPressure(repo: RepoSessionAggregate): boolean {
  return repo.compactions >= 2 && repo.compactions >= repo.sessions * COMPACTION_RATE_THRESHOLD;
}

/** Sessions that ran validation and never saw it pass: work that likely needs human follow-up. */
export function hasNeverGreenPressure(repo: RepoSessionAggregate): boolean {
  return repo.neverGreenSessions >= NEVER_GREEN_THRESHOLD;
}

/** Whether the agent brief should carry this project's dossier. */
export function needsAttention(repo: RepoSessionAggregate): boolean {
  return (
    hasMaterialToolProblems(repo) ||
    hasNeverGreenPressure(repo) ||
    hasCompactionPressure(repo) ||
    repo.partialSessions > 0
  );
}

/** Shared ordering for the agent brief's project dossiers. */
export function compareAttention(left: RepoSessionAggregate, right: RepoSessionAggregate): number {
  return (
    right.operationalFailures - left.operationalFailures ||
    right.unknownOutcomes - left.unknownOutcomes ||
    right.neverGreenSessions - left.neverGreenSessions ||
    right.compactions / Math.max(right.sessions, 1) -
      left.compactions / Math.max(left.sessions, 1) ||
    right.partialSessions - left.partialSessions ||
    left.project.localeCompare(right.project)
  );
}
