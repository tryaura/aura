import { utcTimestampMs } from "./iso-time.js";
import type { WorkItemAggregate } from "./session-detail-metrics.js";
import type { AgentSessionMetrics } from "./session-metrics.js";
import { boundedAdd } from "./session-numbers.js";

/**
 * Joins sessions by the issue keys they mentioned: the loose work-item association.
 *
 * The span between the first session start and the last session end is a rough task-elapsed
 * signal, not a precise completion time — handovers between sessions, reviews, and merges are
 * invisible here, so consumers must treat it as a lower bound on the real timeline.
 */
export function aggregateWorkItems(
  sessions: readonly AgentSessionMetrics[],
): readonly WorkItemAggregate[] {
  const byKey = new Map<
    string,
    {
      firstSeen: string | undefined;
      lastSeen: string | undefined;
      sessions: number;
      wallClockMs: number;
    }
  >();
  for (const session of sessions) {
    for (const key of session.workItems) {
      const entry = byKey.get(key) ?? {
        firstSeen: undefined,
        lastSeen: undefined,
        sessions: 0,
        wallClockMs: 0,
      };
      entry.sessions = boundedAdd(entry.sessions, 1);
      entry.wallClockMs = boundedAdd(entry.wallClockMs, session.wallClockMs);
      entry.firstSeen = earlier(entry.firstSeen, session.startedAt);
      entry.lastSeen = later(entry.lastSeen, session.endedAt);
      byKey.set(key, entry);
    }
  }
  return [...byKey.entries()]
    .map(([key, entry]) => ({ key, ...entry, spanMs: spanMs(entry.firstSeen, entry.lastSeen) }))
    .sort(
      (left, right) =>
        right.sessions - left.sessions ||
        right.wallClockMs - left.wallClockMs ||
        left.key.localeCompare(right.key),
    );
}

function earlier(current: string | undefined, candidate: string | undefined): string | undefined {
  if (current === undefined || (candidate !== undefined && candidate < current)) {
    return candidate ?? current;
  }
  return current;
}

function later(current: string | undefined, candidate: string | undefined): string | undefined {
  if (current === undefined || (candidate !== undefined && candidate > current)) {
    return candidate ?? current;
  }
  return current;
}

function spanMs(firstSeen: string | undefined, lastSeen: string | undefined): number {
  const first = firstSeen === undefined ? undefined : utcTimestampMs(firstSeen);
  const last = lastSeen === undefined ? undefined : utcTimestampMs(lastSeen);
  if (first === undefined || last === undefined || last < first) {
    return 0;
  }
  return last - first;
}
