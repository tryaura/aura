import type {
  AgentSessionMetrics,
  CompactionProfile,
  OutcomeCount,
  OutcomeEvidence,
  OutcomeKind,
  ToolOutcome,
} from "./session-metrics.js";

const OUTCOME_GROUP_LIMIT = 5;
const EXEMPLARS_PER_OUTCOME = 2;

interface MutableOutcomeGroup {
  readonly outcome: ToolOutcome;
  count: number;
  readonly exemplars: OutcomeEvidence[];
}

export interface OutcomeSummary {
  readonly checkFailures: number;
  readonly expectedStatuses: number;
  readonly operationalFailures: number;
  readonly outcomeCounts: readonly OutcomeCount[];
  readonly outcomeGroupCount: number;
  readonly unknownOutcomes: number;
}

export function summarizeOutcomes(sessions: readonly AgentSessionMetrics[]): OutcomeSummary {
  const groups = new Map<string, MutableOutcomeGroup>();
  const counts = new Map<OutcomeKind, number>();
  for (const session of sessions) {
    for (const outcome of session.outcomes) {
      counts.set(outcome.kind, (counts.get(outcome.kind) ?? 0) + 1);
      addOutcome(groups, session, outcome);
    }
  }
  const outcomeGroups = [...groups.values()].map(toOutcomeCount);
  return {
    checkFailures: counts.get("check_failure") ?? 0,
    expectedStatuses: (counts.get("pending_status") ?? 0) + (counts.get("no_match") ?? 0),
    operationalFailures: (counts.get("invocation_error") ?? 0) + (counts.get("tool_error") ?? 0),
    outcomeCounts: selectOutcomeGroups(outcomeGroups),
    outcomeGroupCount: outcomeGroups.length,
    unknownOutcomes: counts.get("unknown_nonzero") ?? 0,
  };
}

function addOutcome(
  groups: Map<string, MutableOutcomeGroup>,
  session: AgentSessionMetrics,
  outcome: ToolOutcome,
): void {
  const key = `${outcome.kind}\u0000${outcome.label}\u0000${outcome.exitCode ?? "none"}`;
  const group = groups.get(key) ?? { count: 0, exemplars: [], outcome };
  group.count += 1;
  const evidence = evidenceOf(session, outcome);
  if (evidence !== undefined) {
    recordDiverseExemplar(group.exemplars, evidence);
  }
  groups.set(key, group);
}

function evidenceOf(
  session: AgentSessionMetrics,
  outcome: ToolOutcome,
): OutcomeEvidence | undefined {
  if (session.transcriptPath === undefined) {
    return undefined;
  }
  return {
    branch: session.git.branch,
    callLine: outcome.callLine,
    commitHash: session.git.commitHash,
    cwd: session.cwd,
    file: session.transcriptPath,
    initialPromptChars: session.initialPromptChars,
    initialPromptLines: session.initialPromptLines,
    resultLine: outcome.resultLine,
    sessionId: session.sessionId,
  };
}

function recordDiverseExemplar(exemplars: OutcomeEvidence[], candidate: OutcomeEvidence): void {
  const duplicate = exemplars.some(
    (existing) =>
      existing.sessionId === candidate.sessionId && existing.resultLine === candidate.resultLine,
  );
  if (duplicate) {
    return;
  }
  exemplars.push(candidate);
  if (exemplars.length > EXEMPLARS_PER_OUTCOME) {
    const sameDirectory = exemplars.findIndex(
      (existing, index) => index < exemplars.length - 1 && existing.cwd === candidate.cwd,
    );
    exemplars.splice(sameDirectory >= 0 ? sameDirectory : 0, 1);
  }
}

function toOutcomeCount(group: MutableOutcomeGroup): OutcomeCount {
  return {
    confidence: group.outcome.confidence,
    count: group.count,
    exemplars: group.exemplars,
    exitCode: group.outcome.exitCode,
    kind: group.outcome.kind,
    label: group.outcome.label,
    reason: group.outcome.reason,
  };
}

function outcomePriority(kind: OutcomeKind): number {
  if (kind === "invocation_error" || kind === "tool_error") {
    return 0;
  }
  if (kind === "check_failure") {
    return 1;
  }
  if (kind === "unknown_nonzero") {
    return 2;
  }
  return 3;
}

function selectOutcomeGroups(groups: readonly OutcomeCount[]): readonly OutcomeCount[] {
  const ranked = [...groups].sort(
    (left, right) =>
      right.count - left.count ||
      outcomePriority(left.kind) - outcomePriority(right.kind) ||
      left.label.localeCompare(right.label),
  );
  const selected = ranked.slice(0, OUTCOME_GROUP_LIMIT);
  const hasOperational = selected.some(
    (group) => group.kind === "invocation_error" || group.kind === "tool_error",
  );
  if (hasOperational || selected.length < OUTCOME_GROUP_LIMIT) {
    return selected;
  }
  const operational = ranked.find(
    (group) => group.kind === "invocation_error" || group.kind === "tool_error",
  );
  return operational === undefined ? selected : [...selected.slice(0, -1), operational];
}

export function compactionProfileOf(sessions: readonly AgentSessionMetrics[]): CompactionProfile {
  const compacted = sessions.filter((session) => session.compactions > 0);
  const clean = sessions.filter((session) => session.compactions === 0);
  return {
    compactedSessions: compacted.length,
    compactedInitialPromptCharsAverage: average(compacted, "initialPromptChars"),
    compactedToolOutputCharsAverage: average(compacted, "toolOutputChars"),
    compactedTurnsAverage: average(compacted, "turns"),
    cleanSessions: clean.length,
    cleanInitialPromptCharsAverage: average(clean, "initialPromptChars"),
    cleanToolOutputCharsAverage: average(clean, "toolOutputChars"),
    cleanTurnsAverage: average(clean, "turns"),
  };
}

function average(
  sessions: readonly AgentSessionMetrics[],
  field: "initialPromptChars" | "toolOutputChars" | "turns",
): number {
  if (sessions.length === 0) {
    return 0;
  }
  return Math.round(sessions.reduce((sum, session) => sum + session[field], 0) / sessions.length);
}
