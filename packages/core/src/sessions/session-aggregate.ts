import type {
  AgentSessionMetrics,
  DirectoryHotspot,
  RepoSessionAggregate,
  SessionTokenUsage,
} from "./session-metrics.js";
import { projectNameFromRepositoryUrl } from "./project-resolve.js";
import { compactionProfileOf, summarizeOutcomes } from "./session-outcome-aggregate.js";

/** How many trouble-concentrating directories a project names. */
const TOP_HOTSPOTS = 3;

/**
 * Sums session metrics per project.
 *
 * Grouping is by resolved project label (`project-resolve.ts`), so parallel worktrees and
 * repeated clones of one repository land in one row while unrelated directories stay their own.
 * Sessions with no recorded directory share one unnamed group so their volume stays visible.
 */
export function aggregateSessionsByRepo(
  sessions: readonly AgentSessionMetrics[],
  projectLabels: ReadonlyMap<string, string>,
): readonly RepoSessionAggregate[] {
  const groups = new Map<string, { directories: Set<string>; sessions: AgentSessionMetrics[] }>();
  for (const session of sessions) {
    const recordedProject =
      session.git.repositoryUrl === undefined
        ? undefined
        : projectNameFromRepositoryUrl(session.git.repositoryUrl);
    const label = recordedProject ?? fallbackProject(session.cwd, projectLabels);
    const group = groups.get(label);
    if (group === undefined) {
      groups.set(label, {
        directories: new Set(session.cwd === undefined ? [] : [session.cwd]),
        sessions: [session],
      });
    } else {
      if (session.cwd !== undefined) {
        group.directories.add(session.cwd);
      }
      group.sessions.push(session);
    }
  }

  return [...groups.entries()]
    .map(([project, group]) =>
      aggregateGroup(project, Math.max(group.directories.size, 1), group.sessions),
    )
    .sort(
      (left, right) =>
        right.sessions - left.sessions ||
        right.agentTimeMs - left.agentTimeMs ||
        left.project.localeCompare(right.project),
    );
}

function fallbackProject(
  cwd: string | undefined,
  projectLabels: ReadonlyMap<string, string>,
): string {
  return cwd === undefined ? "(no recorded directory)" : (projectLabels.get(cwd) ?? cwd);
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
  let toolCalls = 0;
  let toolTimeMs = 0;
  let truncatedSessions = 0;
  let turns = 0;
  let validationTimeMs = 0;
  let wallClockMs = 0;
  const tokens = { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0 };

  for (const session of sessions) {
    agentTimeMs += session.agentTimeMs;
    abortedTurns += session.abortedTurns;
    compactions += session.compactions;
    interventions += session.interventions.length;
    toolTimeMs += session.toolTimeMs;
    turns += session.turns;
    validationTimeMs += session.validation?.timeMs ?? 0;
    wallClockMs += session.wallClockMs;
    if (session.truncated) {
      truncatedSessions += 1;
    }
    for (const usage of Object.values(session.tools)) {
      toolCalls += usage.calls;
      failedToolCalls += usage.failures;
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
    spot.compactions += session.compactions;
    spot.failedToolCalls += Object.values(session.tools).reduce(
      (sum, usage) => sum + usage.failures,
      0,
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
  totals.cachedInputTokens += tokens.cachedInputTokens;
  totals.inputTokens += tokens.inputTokens;
  totals.outputTokens += tokens.outputTokens;
}
