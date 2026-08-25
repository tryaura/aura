import type { SessionAnalysis } from "@tryaura/core";

import {
  compactCount,
  count,
  duration,
  gaugeRow,
  gradeOf,
  percent,
  ratio,
  worstGrade,
  type Grade,
  type GradeBands,
} from "./chart.js";

/**
 * The `Overall` section of the sessions report: the totals line, the graded gauges, and the
 * quota note. Split from `render.ts` only for the file-size cap; the wording and thresholds are
 * one surface with the rest of the report.
 */

/**
 * Grade bands, read as the upper bound each grade stays below; at or past the last is an F.
 *
 * Deliberately coarse: these are health signals over noisy data, so each band is wide enough
 * that ordinary variation between windows does not flip a grade.
 */
const TOOL_SHARE_BANDS: GradeBands = [0.1, 0.2, 0.35, 0.5];
const FAILURE_BANDS: GradeBands = [0.02, 0.05, 0.1, 0.2];
const COMPACTION_BANDS: GradeBands = [0.1, 0.3, 0.6, 1];
/** Graded on the miss share, so A means at least 90% of input tokens came from cache. */
const CACHE_MISS_BANDS: GradeBands = [0.1, 0.2, 0.35, 0.5];

export function overallRows(analysis: SessionAnalysis): readonly string[] {
  const totals = analysis.repos.reduce(
    (sum, repo) => ({
      cachedInputTokens: sum.cachedInputTokens + repo.tokens.cachedInputTokens,
      checkFailures: sum.checkFailures + repo.checkFailures,
      compactions: sum.compactions + repo.compactions,
      expectedStatuses: sum.expectedStatuses + repo.expectedStatuses,
      inputTokens: sum.inputTokens + repo.tokens.inputTokens,
      outputTokens: sum.outputTokens + repo.tokens.outputTokens,
      toolCalls: sum.toolCalls + repo.toolCalls,
      toolProblems: sum.toolProblems + repo.operationalFailures + repo.unknownOutcomes,
      toolTimeMs: sum.toolTimeMs + repo.toolTimeMs,
      wallClockMs: sum.wallClockMs + repo.wallClockMs,
    }),
    {
      cachedInputTokens: 0,
      checkFailures: 0,
      compactions: 0,
      expectedStatuses: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      toolProblems: 0,
      toolTimeMs: 0,
      wallClockMs: 0,
    },
  );
  const toolShare = ratio(totals.toolTimeMs, totals.wallClockMs);
  const failureShare = ratio(totals.toolProblems, totals.toolCalls);
  const compactionRate = ratio(totals.compactions, analysis.sessions.length);
  const cacheShare = ratio(totals.cachedInputTokens, totals.inputTokens);
  const toolGrade = gradeOf(toolShare, TOOL_SHARE_BANDS);
  const failureGrade = gradeOf(failureShare, FAILURE_BANDS);
  const compactionGrade = gradeOf(compactionRate, COMPACTION_BANDS);
  // The cache gauge grades the miss share: reused input is the healthy direction.
  const cacheGrade = gradeOf(1 - cacheShare, CACHE_MISS_BANDS);
  const graded: Grade[] = [toolGrade, failureGrade];
  if (totals.compactions > 0) {
    graded.push(compactionGrade);
  }
  if (totals.inputTokens > 0) {
    graded.push(cacheGrade);
  }
  const tokensPart =
    totals.inputTokens > 0
      ? ` · ${compactCount(totals.inputTokens)} tokens in, ${compactCount(totals.outputTokens)} out`
      : "";
  const rows = [
    `  Overall · ${worstGrade(graded)}`,
    `    ${count(analysis.sessions.length, "session")} in ${count(analysis.repos.length, "project")} · ${duration(totals.wallClockMs)} wall${tokensPart}`,
    `    ${gaugeRow("in tools", toolShare, `${toolGrade} · ${percent(toolShare)} of wall time`)}`,
    `    ${gaugeRow(
      "tool errs",
      failureShare,
      `${failureGrade} · ${percent(failureShare)} of ${count(totals.toolCalls, "tool call")}`,
    )}`,
  ];
  if (totals.checkFailures > 0 || totals.expectedStatuses > 0) {
    rows.push(
      `    ${count(totals.checkFailures, "check failure")} · ${count(totals.expectedStatuses, "expected nonzero status", "expected nonzero statuses")}`,
    );
  }
  if (totals.inputTokens > 0) {
    rows.push(
      `    ${gaugeRow("cache hit", cacheShare, `${cacheGrade} · ${percent(cacheShare)} of input tokens reused`)}`,
    );
  }
  if (totals.compactions > 0) {
    rows.push(
      `    ${gaugeRow(
        "compaction",
        compactionRate,
        `${compactionGrade} · ${compactionRate.toFixed(2)} per session — each one hit the context limit`,
      )}`,
    );
  }
  const quota = quotaNote(analysis);
  if (quota !== undefined) {
    rows.push(`    ${quota}`);
  }
  if (analysis.unreadableFiles > 0) {
    rows.push(`    ${count(analysis.unreadableFiles, "transcript file")} could not be read`);
  }
  return rows;
}

/**
 * The subscription-quota peak across the window, when any session reported one.
 *
 * The counter is account-global and shared by concurrent sessions, so only the peak is honest;
 * attributing deltas to individual sessions would double-count parallel work.
 */
function quotaNote(analysis: SessionAnalysis): string | undefined {
  let peak:
    | { planType?: string | undefined; usedPercent: number; windowMinutes?: number | undefined }
    | undefined;
  for (const session of analysis.sessions) {
    if (session.quota !== undefined && session.quota.usedPercent >= (peak?.usedPercent ?? -1)) {
      peak = session.quota;
    }
  }
  if (peak === undefined) {
    return undefined;
  }
  const plan = peak.planType === undefined ? "plan" : `${peak.planType} plan`;
  const window =
    peak.windowMinutes === undefined
      ? "window"
      : `${Math.round(peak.windowMinutes / 1440)}-day window`;
  return `Quota peaked at ${percent(peak.usedPercent / 100)} of the ${plan}'s ${window}`;
}
