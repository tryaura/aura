import type {
  AgentSessionMetrics,
  DirectoryHotspot,
  RepoSessionAggregate,
  SessionTokenUsage,
} from "./session-metrics.js";
import { repositoryIdentityFromUrl, type ProjectIdentity } from "./project-resolve.js";
import { boundedAdd } from "./session-numbers.js";
import { compactionProfileOf, summarizeOutcomes } from "./session-outcome-aggregate.js";

/** How many trouble-concentrating directories a project names. */
const TOP_HOTSPOTS = 3;

/**
 * Sums session metrics per project.
 *
 * Grouping is by resolved project identity (`project-resolve.ts`), so parallel worktrees and
 * repeated clones of one repository land in one row while unrelated directories stay their own.
 * Sessions with no recorded directory share one unnamed group so their volume stays visible.
 */
export function aggregateSessionsByRepo(
  sessions: readonly AgentSessionMetrics[],
  projectLabels: ReadonlyMap<string, ProjectIdentity>,
): readonly RepoSessionAggregate[] {
  const recordedByLabel = recordedIdentitiesByLabel(sessions);
  const groups = new Map<
    string,
    { directories: Set<string>; identity: ProjectIdentity; sessions: AgentSessionMetrics[] }
  >();
  for (const session of sessions) {
    const recordedIdentity =
      session.git.repositoryUrl === undefined
        ? undefined
        : repositoryIdentityFromUrl(session.git.repositoryUrl);
    const fallback = fallbackProject(session.cwd, projectLabels);
    const identity =
      recordedIdentity ?? uniqueRecordedIdentity(recordedByLabel, fallback) ?? fallback;
    const group = groups.get(identity.key);
    if (group === undefined) {
      groups.set(identity.key, {
        directories: new Set(session.cwd === undefined ? [] : [session.cwd]),
        identity,
        sessions: [session],
      });
    } else {
      if (session.cwd !== undefined) {
        group.directories.add(session.cwd);
      }
      group.sessions.push(session);
    }
  }

  const labelCounts = new Map<string, number>();
  for (const group of groups.values()) {
    labelCounts.set(group.identity.label, (labelCounts.get(group.identity.label) ?? 0) + 1);
  }
  return [...groups.entries()]
    .map(([, group]) => {
      const project =
        (labelCounts.get(group.identity.label) ?? 0) > 1
          ? group.identity.qualifiedLabel
          : group.identity.label;
      return aggregateGroup(project, Math.max(group.directories.size, 1), group.sessions);
    })
    .sort(
      (left, right) =>
        right.sessions - left.sessions ||
        right.agentTimeMs - left.agentTimeMs ||
        left.project.localeCompare(right.project),
    );
}

function recordedIdentitiesByLabel(
  sessions: readonly AgentSessionMetrics[],
): ReadonlyMap<string, ReadonlyMap<string, ProjectIdentity>> {
  const byLabel = new Map<string, Map<string, ProjectIdentity>>();
  for (const session of sessions) {
    const identity =
      session.git.repositoryUrl === undefined
        ? undefined
        : repositoryIdentityFromUrl(session.git.repositoryUrl);
    if (identity === undefined) {
      continue;
    }
    const identities = byLabel.get(identity.label) ?? new Map<string, ProjectIdentity>();
    identities.set(identity.key, identity);
    byLabel.set(identity.label, identities);
  }
  return byLabel;
}

function uniqueRecordedIdentity(
  recordedByLabel: ReadonlyMap<string, ReadonlyMap<string, ProjectIdentity>>,
  fallback: ProjectIdentity,
): ProjectIdentity | undefined {
  // A live checkout's remote is already authoritative. Only unresolved path/worktree labels may
  // borrow the sole historical identity with the same human-readable repository name.
  if (fallback.key.startsWith("remote:")) {
    return undefined;
  }
  const candidates = recordedByLabel.get(fallback.label);
  if (candidates === undefined || candidates.size !== 1) {
    return undefined;
  }
  return candidates.values().next().value;
}

function fallbackProject(
  cwd: string | undefined,
  projectLabels: ReadonlyMap<string, ProjectIdentity>,
): ProjectIdentity {
  if (cwd === undefined) {
    return {
      key: "missing-directory",
      label: "(no recorded directory)",
      qualifiedLabel: "(no recorded directory)",
    };
  }
  return projectLabels.get(cwd) ?? { key: `path:${cwd}`, label: cwd, qualifiedLabel: cwd };
}

function aggregateGroup(
  project: string,
  directories: number,
  sessions: readonly AgentSessionMetrics[],
): RepoSessionAggregate {
  let agentTimeMs = 0;
  let abortedTurns = 0;
  let compactions = 0;
  let failedToolCalls = 0;
  let interventions = 0;
  let invalidValues = 0;
  let malformedLines = 0;
  let partialSessions = 0;
  let readErrorSessions = 0;
  let toolCalls = 0;
  let toolTimeMs = 0;
  let truncatedSessions = 0;
  let turns = 0;
  let validationTimeMs = 0;
  let wallClockMs = 0;
  const tokens = { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0 };

  for (const session of sessions) {
    agentTimeMs = boundedAdd(agentTimeMs, session.agentTimeMs);
    abortedTurns = boundedAdd(abortedTurns, session.abortedTurns);
    compactions = boundedAdd(compactions, session.compactions);
    interventions = boundedAdd(interventions, session.interventions.length);
    invalidValues = boundedAdd(invalidValues, session.invalidValues);
    malformedLines = boundedAdd(malformedLines, session.malformedLines);
    toolTimeMs = boundedAdd(toolTimeMs, session.toolTimeMs);
    turns = boundedAdd(turns, session.turns);
    validationTimeMs = boundedAdd(validationTimeMs, session.validation?.timeMs ?? 0);
    wallClockMs = boundedAdd(wallClockMs, session.wallClockMs);
    if (session.partial) {
      partialSessions += 1;
    }
    if (session.readError) {
      readErrorSessions += 1;
    }
    if (session.truncated) {
      truncatedSessions += 1;
    }
    for (const usage of Object.values(session.tools)) {
      toolCalls = boundedAdd(toolCalls, usage.calls);
      failedToolCalls = boundedAdd(failedToolCalls, usage.failures);
    }
    addTokens(tokens, session.tokens);
  }

  const outcomes = summarizeOutcomes(sessions);
  return {
    ...outcomes,
    agentTimeMs,
    abortedTurns,
    compactions,
    compactionProfile: compactionProfileOf(sessions),
    directories,
    failedToolCalls,
    hotspots: hotspotsOf(sessions),
    interventions,
    invalidValues,
    malformedLines,
    neverGreenSessions: sessions.filter(ranValidationWithoutGreen).length,
    partialSessions,
    readErrorSessions,
    project,
    sessions: sessions.length,
    tokens,
    toolCalls,
    toolTimeMs,
    truncatedSessions,
    turns,
    validationTimeMs,
    wallClockMs,
  };
}

/** Whether the session ran recognized validation and never recorded a passing run. */
function ranValidationWithoutGreen(session: AgentSessionMetrics): boolean {
  return (
    session.validation !== undefined &&
    session.validation.attempts > 0 &&
    session.validation.iterationsToFirstGreen === undefined
  );
}

/** The directories where failures or compactions concentrate, worst first. */
function hotspotsOf(sessions: readonly AgentSessionMetrics[]): readonly DirectoryHotspot[] {
  const byCwd = new Map<
    string,
    { compactions: number; failedToolCalls: number; sessions: number }
  >();
  for (const session of sessions) {
    if (session.cwd === undefined) {
      continue;
    }
    const spot = byCwd.get(session.cwd) ?? { compactions: 0, failedToolCalls: 0, sessions: 0 };
    spot.compactions = boundedAdd(spot.compactions, session.compactions);
    spot.failedToolCalls = Object.values(session.tools).reduce(
      (sum, usage) => boundedAdd(sum, usage.failures),
      spot.failedToolCalls,
    );
    spot.sessions += 1;
    byCwd.set(session.cwd, spot);
  }
  return [...byCwd.entries()]
    .map(([cwd, spot]) => ({ cwd, ...spot }))
    .filter((spot) => spot.failedToolCalls > 0 || spot.compactions > 0)
    .sort(
      (left, right) =>
        right.failedToolCalls + right.compactions - (left.failedToolCalls + left.compactions) ||
        left.cwd.localeCompare(right.cwd),
    )
    .slice(0, TOP_HOTSPOTS);
}

function addTokens(
  totals: { cachedInputTokens: number; inputTokens: number; outputTokens: number },
  tokens: SessionTokenUsage | undefined,
): void {
  if (tokens === undefined) {
    return;
  }
  totals.cachedInputTokens = boundedAdd(totals.cachedInputTokens, tokens.cachedInputTokens);
  totals.inputTokens = boundedAdd(totals.inputTokens, tokens.inputTokens);
  totals.outputTokens = boundedAdd(totals.outputTokens, tokens.outputTokens);
}
