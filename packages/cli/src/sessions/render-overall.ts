import type { SessionAnalysis } from "@tryaura/core";

import { wrapWords } from "../text-width.js";
import {
  compactCount,
  count,
  duration,
  gradeOf,
  median,
  metricCards,
  percent,
  ratio,
  type GradeBands,
  type MetricCard,
} from "./chart.js";
import { deliveryNoteRows, validationTotals } from "./render-insights.js";

/** The headline cards and the two compact detail sections that follow project attention. */

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
/** Peak window occupancy: an F means compaction was imminent when the session peaked. */
const CONTEXT_BANDS: GradeBands = [0.5, 0.7, 0.85, 0.95];

interface OverallTotals {
  cachedInputTokens: number;
  checkFailures: number;
  compactions: number;
  expectedStatuses: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  toolProblems: number;
  toolTimeMs: number;
  turns: number;
  wallClockMs: number;
}

export interface SessionSummarySections {
  readonly activity: readonly string[];
  readonly health: readonly string[];
  readonly workflow: readonly string[];
}

/** Computes the human summary once, then lets `render.ts` place attention between its sections. */
export function sessionSummarySections(
  analysis: SessionAnalysis,
  columns: number,
): SessionSummarySections {
  const totals = sumRepoTotals(analysis);
  const validation = validationTotals(analysis);
  const context = peakContextShare(analysis);
  return {
    activity: activityRows(analysis, totals, columns),
    health: [
      "  Session health",
      ...metricCards(healthCards(analysis, totals, validation, context), columns),
    ],
    workflow: workflowRows(analysis, totals, columns),
  };
}

function healthCards(
  analysis: SessionAnalysis,
  totals: OverallTotals,
  validation: ReturnType<typeof validationTotals>,
  context: ContextPeak | undefined,
): readonly MetricCard[] {
  const failureShare = ratio(totals.toolProblems, totals.toolCalls);
  const compactionRate = ratio(totals.compactions, analysis.sessions.length);
  const toolErrors: MetricCard =
    totals.toolCalls === 0
      ? { detail: "", title: "Tool errors", value: "No tool calls" }
      : {
          detail: `${compactCount(totals.toolProblems)} / ${compactCount(totals.toolCalls)}`,
          title: "Tool errors",
          value: `${gradeOf(failureShare, FAILURE_BANDS)} · ${percent(failureShare)}`,
        };
  const contextCard: MetricCard =
    context === undefined
      ? { detail: "", title: "Context", value: "Not recorded" }
      : {
          detail: `${compactCount(context.window)} window`,
          title: "Context",
          value: `${gradeOf(context.share, CONTEXT_BANDS)} · ${percent(context.share)} peak`,
        };
  const validationCard: MetricCard =
    validation.attempts === 0
      ? { detail: "runs recorded", title: "Validation", value: "No validation" }
      : {
          detail: `${duration(validation.timeMs)} spent`,
          title: "Validation",
          value: `${compactCount(validation.failures)} / ${compactCount(validation.attempts)} failed`,
        };
  return [
    toolErrors,
    contextCard,
    {
      detail: `${compactCount(totals.compactions)} total`,
      title: "Compactions",
      value: `${gradeOf(compactionRate, COMPACTION_BANDS)} · ${compactionRate.toFixed(2)}/session`,
    },
    validationCard,
  ];
}

function activityRows(
  analysis: SessionAnalysis,
  totals: OverallTotals,
  columns: number,
): readonly string[] {
  const rows = ["", "  Activity"];
  rows.push(
    ...summaryRow(
      "Sessions",
      `${count(analysis.sessions.length, "session")} · ${count(analysis.repos.length, "project")}`,
      columns,
    ),
    ...summaryRow("Agent time", duration(totals.wallClockMs), columns),
    ...summaryRow("Turns", count(totals.turns, "turn"), columns),
  );
  if (totals.inputTokens > 0) {
    rows.push(
      ...summaryRow("Tokens in", compactCount(totals.inputTokens), columns),
      ...summaryRow("Tokens out", compactCount(totals.outputTokens), columns),
    );
  }
  return rows;
}

function workflowRows(
  analysis: SessionAnalysis,
  totals: OverallTotals,
  columns: number,
): readonly string[] {
  const rows = ["", "  Workflow and delivery"];
  const turn = medianTurn(analysis);
  if (turn !== undefined) {
    rows.push(...summaryRow("Median turn", duration(turn), columns));
  }
  const toolShare = ratio(totals.toolTimeMs, totals.wallClockMs);
  rows.push(
    ...summaryRow(
      "Time in tools",
      `${gradeOf(toolShare, TOOL_SHARE_BANDS)} · ${percent(toolShare)} of agent time`,
      columns,
    ),
  );
  if (totals.inputTokens > 0) {
    const cacheShare = ratio(totals.cachedInputTokens, totals.inputTokens);
    rows.push(
      ...summaryRow(
        "Cache hit",
        `${gradeOf(1 - cacheShare, CACHE_MISS_BANDS)} · ${percent(cacheShare)} reused`,
        columns,
      ),
    );
  }
  if (totals.checkFailures > 0) {
    rows.push(...summaryRow("Check failures", String(totals.checkFailures), columns));
  }
  if (totals.expectedStatuses > 0) {
    rows.push(...summaryRow("Expected statuses", String(totals.expectedStatuses), columns));
  }
  rows.push(...interventionRows(analysis, columns));
  for (const note of deliveryNoteRows(analysis)) {
    rows.push(...summaryRow(note.label, note.value, columns));
  }
  if (analysis.unreadableFiles > 0) {
    rows.push(
      ...summaryRow("Unreadable", count(analysis.unreadableFiles, "transcript file"), columns),
    );
  }
  return rows;
}

function summaryRow(label: string, value: string, columns: number): readonly string[] {
  const indent = "    ";
  const labelWidth = 18;
  const prefix = `${indent}${label.padEnd(labelWidth)}`;
  const continuation = " ".repeat(prefix.length);
  return wrapWords(value, Math.max(16, columns - prefix.length)).map(
    (line, index) => `${index === 0 ? prefix : continuation}${line}`,
  );
}

function sumRepoTotals(analysis: SessionAnalysis): OverallTotals {
  const totals: OverallTotals = {
    cachedInputTokens: 0,
    checkFailures: 0,
    compactions: 0,
    expectedStatuses: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    toolProblems: 0,
    toolTimeMs: 0,
    turns: 0,
    wallClockMs: 0,
  };
  for (const repo of analysis.repos) {
    totals.cachedInputTokens += repo.tokens.cachedInputTokens;
    totals.checkFailures += repo.checkFailures;
    totals.compactions += repo.compactions;
    totals.expectedStatuses += repo.expectedStatuses;
    totals.inputTokens += repo.tokens.inputTokens;
    totals.outputTokens += repo.tokens.outputTokens;
    totals.toolCalls += repo.toolCalls;
    totals.toolProblems += repo.operationalFailures + repo.unknownOutcomes;
    totals.toolTimeMs += repo.toolTimeMs;
    totals.turns += repo.turns;
    totals.wallClockMs += repo.wallClockMs;
  }
  return totals;
}

/** The wait a completed prompt typically buys. */
function medianTurn(analysis: SessionAnalysis): number | undefined {
  const durations = analysis.sessions.flatMap((session) =>
    session.turnDetails
      .filter((turn) => turn.closed === "completed")
      .map((turn) => turn.durationMs),
  );
  return median(durations);
}

/** Human steering, one short row per kind instead of one packed sentence. */
function interventionRows(analysis: SessionAnalysis, columns: number): readonly string[] {
  const byKind = new Map<string, number>();
  let total = 0;
  for (const session of analysis.sessions) {
    for (const intervention of session.interventions) {
      byKind.set(intervention.kind, (byKind.get(intervention.kind) ?? 0) + 1);
      total += 1;
    }
  }
  const rows: string[] = [];
  if (total > 0) {
    rows.push(...summaryRow("Interventions", String(total), columns));
  }
  for (const [kind, label] of [
    ["interrupt", "Interrupts"],
    ["reprompt", "Re-prompts"],
    ["approval", "Approvals"],
    ["denial", "Denials"],
  ] as const) {
    const value = byKind.get(kind) ?? 0;
    if (value > 0) {
      rows.push(...summaryRow(label, String(value), columns));
    }
  }
  return rows;
}

/** The busiest single request against its window, across every session that reported one. */
interface ContextPeak {
  readonly share: number;
  readonly window: number;
}

function peakContextShare(analysis: SessionAnalysis): ContextPeak | undefined {
  let peak: ContextPeak | undefined;
  for (const session of analysis.sessions) {
    const context = session.context;
    if (context?.modelContextWindow === undefined || context.modelContextWindow <= 0) {
      continue;
    }
    const share = context.peakRequestTokens / context.modelContextWindow;
    if (share >= (peak?.share ?? -1)) {
      peak = { share, window: context.modelContextWindow };
    }
  }
  return peak;
}
