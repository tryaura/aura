import type {
  AgentSessionMetrics,
  CompactionProfile,
  InvocationErrorCount,
  OutcomeCount,
  OutcomeEvidence,
  OutcomeKind,
  ShellBatchComponentCount,
  ToolOutcome,
} from "./session-metrics.js";
import { boundedAdd, boundedSum } from "./session-numbers.js";

const OUTCOME_GROUP_LIMIT = 5;
const EXEMPLARS_PER_OUTCOME = 2;
const BATCH_COMPONENT_GROUP_LIMIT = 5;

interface MutableOutcomeGroup {
  readonly batchComponents: Map<string, ShellBatchComponentCount>;
  readonly outcome: ToolOutcome;
  count: number;
  readonly exemplars: OutcomeEvidence[];
}

export interface OutcomeSummary {
  readonly checkFailures: number;
  readonly expectedStatuses: number;
  /** The exit-127 subset of `operationalFailures`. */
  readonly invocationErrors: number;
  readonly invocationErrorCounts: readonly InvocationErrorCount[];
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
      counts.set(outcome.kind, boundedAdd(counts.get(outcome.kind) ?? 0, 1));
      addOutcome(groups, session, outcome);
    }
  }
  const outcomeGroups = [...groups.values()].map(toOutcomeCount);
  return {
    checkFailures: counts.get("check_failure") ?? 0,
    expectedStatuses: (counts.get("pending_status") ?? 0) + (counts.get("no_match") ?? 0),
    invocationErrors: counts.get("invocation_error") ?? 0,
    invocationErrorCounts: invocationErrorCounts(outcomeGroups),
    operationalFailures: (counts.get("invocation_error") ?? 0) + (counts.get("tool_error") ?? 0),
    outcomeCounts: selectOutcomeGroups(outcomeGroups),
    outcomeGroupCount: outcomeGroups.length,
    unknownOutcomes: counts.get("unknown_nonzero") ?? 0,
  };
}

function invocationErrorCounts(groups: readonly OutcomeCount[]): readonly InvocationErrorCount[] {
  const counts = new Map<string, number>();
  for (const group of groups) {
    if (group.kind === "invocation_error") {
      counts.set(group.label, boundedAdd(counts.get(group.label) ?? 0, group.count));
    }
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ count, label }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function addOutcome(
  groups: Map<string, MutableOutcomeGroup>,
  session: AgentSessionMetrics,
  outcome: ToolOutcome,
): void {
  const key = `${outcome.kind}\u0000${outcome.label}\u0000${outcome.exitCode ?? "none"}`;
  const group = groups.get(key) ?? {
    batchComponents: new Map<string, ShellBatchComponentCount>(),
    count: 0,
    exemplars: [],
    outcome,
  };
  group.count = boundedAdd(group.count, 1);
  addBatchComponents(group.batchComponents, outcome);
  const evidence = evidenceOf(session, outcome);
  if (evidence !== undefined) {
    recordDiverseExemplar(group.exemplars, evidence);
  }
  groups.set(key, group);
}

function addBatchComponents(
  counts: Map<string, ShellBatchComponentCount>,
  outcome: ToolOutcome,
): void {
  for (const component of outcome.batchComponents ?? []) {
    const key = `${component.command}\u0000${component.subcommand ?? ""}`;
    const current = counts.get(key);
    counts.set(key, {
      ...component,
      count: boundedAdd(current?.count ?? 0, 1),
    });
  }
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
  const batchComponents = [...group.batchComponents.values()]
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.command.localeCompare(right.command) ||
        (left.subcommand ?? "").localeCompare(right.subcommand ?? ""),
    )
    .slice(0, BATCH_COMPONENT_GROUP_LIMIT);
  return {
    ...(batchComponents.length === 0
      ? {}
      : {
          batchComponentCount: group.batchComponents.size,
          batchComponents,
        }),
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
  return Math.round(boundedSum(sessions.map((session) => session[field])) / sessions.length);
}
