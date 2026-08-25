import type { RepoSessionAggregate } from "@tryaura/core";

const FAILURE_COUNT_THRESHOLD = 3;
const FAILURE_RATE_THRESHOLD = 0.05;
const COMPACTION_RATE_THRESHOLD = 0.5;

/** Outcomes that may indicate an execution problem; ordinary check failures stay separate. */
export function toolProblemCount(repo: RepoSessionAggregate): number {
  return repo.operationalFailures + repo.unknownOutcomes;
}

export function hasMaterialToolProblems(repo: RepoSessionAggregate): boolean {
  const problems = toolProblemCount(repo);
  return (
    problems >= FAILURE_COUNT_THRESHOLD ||
    (problems > 0 && problems >= repo.toolCalls * FAILURE_RATE_THRESHOLD)
  );
}

export function hasMaterialCheckFailures(repo: RepoSessionAggregate): boolean {
  return (
    repo.checkFailures >= FAILURE_COUNT_THRESHOLD ||
    (repo.checkFailures > 0 && repo.checkFailures >= repo.toolCalls * FAILURE_RATE_THRESHOLD)
  );
}

export function hasCompactionPressure(repo: RepoSessionAggregate): boolean {
  return repo.compactions >= 2 && repo.compactions >= repo.sessions * COMPACTION_RATE_THRESHOLD;
}

export function needsAttention(repo: RepoSessionAggregate): boolean {
  return (
    hasMaterialToolProblems(repo) ||
    hasMaterialCheckFailures(repo) ||
    hasCompactionPressure(repo) ||
    repo.truncatedSessions > 0
  );
}

/** Shared ordering for the human report and agent brief. */
export function compareAttention(left: RepoSessionAggregate, right: RepoSessionAggregate): number {
  return (
    right.operationalFailures - left.operationalFailures ||
    right.unknownOutcomes - left.unknownOutcomes ||
    right.checkFailures - left.checkFailures ||
    right.compactions / Math.max(right.sessions, 1) -
      left.compactions / Math.max(left.sessions, 1) ||
    right.truncatedSessions - left.truncatedSessions ||
    left.project.localeCompare(right.project)
  );
}
