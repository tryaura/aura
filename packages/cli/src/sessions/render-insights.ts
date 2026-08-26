import type { SessionAnalysis } from "@tryaura/core";

import { wrapWords } from "../text-width.js";
import { bar, chartLabel, compactCount, count, duration, median, percent, ratio } from "./chart.js";
import { safe } from "../safe-text.js";

/**
 * The insight sections of the sessions report: delivery notes inside `Overall`, the command
 * chart, and the work-item join. Split from `render.ts` only for the file-size cap; the wording
 * is one surface with the rest of the report.
 */

/** How many command identities and work items the report shows; `--json` carries every one. */
const COMMAND_LIMIT = 5;
const WORK_ITEM_LIMIT = 5;

export interface DeliveryNote {
  readonly label: string;
  readonly value: string;
}

/** First-green cost, initial-context cost, and inferred endings. */
export function deliveryNoteRows(analysis: SessionAnalysis): readonly DeliveryNote[] {
  const rows: DeliveryNote[] = [];
  const firstGreen = firstGreenNote(analysis);
  if (firstGreen !== undefined) {
    rows.push(firstGreen);
  }
  const initialTokens = median(
    analysis.sessions.flatMap((session) =>
      session.context?.initialContextTokens === undefined
        ? []
        : [session.context.initialContextTokens],
    ),
  );
  if (initialTokens !== undefined) {
    rows.push({
      label: "Initial context",
      value: `${compactCount(initialTokens)} tokens · median session`,
    });
  }
  const endings = inferredEndingsNote(analysis);
  if (endings !== undefined) {
    rows.push(endings);
  }
  return rows;
}

export interface ValidationTotals {
  readonly attempts: number;
  readonly failures: number;
  readonly timeMs: number;
}

export function validationTotals(analysis: SessionAnalysis): ValidationTotals {
  const totals = { attempts: 0, failures: 0, timeMs: 0 };
  for (const session of analysis.sessions) {
    totals.attempts += session.validation?.attempts ?? 0;
    totals.failures += session.validation?.failures ?? 0;
    totals.timeMs += session.validation?.timeMs ?? 0;
  }
  return totals;
}

/** `first green after 2 runs · 1.2M tokens spent (medians)` over sessions that reached green. */
function firstGreenNote(analysis: SessionAnalysis): DeliveryNote | undefined {
  const iterations = analysis.sessions.flatMap((session) =>
    session.validation?.iterationsToFirstGreen === undefined
      ? []
      : [session.validation.iterationsToFirstGreen],
  );
  const runs = median(iterations);
  if (runs === undefined) {
    return undefined;
  }
  const tokenCosts = analysis.sessions.flatMap((session) => {
    const tokens = session.validation?.tokensAtFirstGreen;
    return tokens === undefined ? [] : [tokens.inputTokens + tokens.outputTokens];
  });
  const tokens = median(tokenCosts);
  const cost = tokens === undefined ? "" : ` · ${compactCount(tokens)} tokens`;
  return { label: "First green", value: `${count(runs, "run")}${cost} · medians` };
}

const ENDING_LABELS = [
  ["completed_autonomously", "autonomous"],
  ["completed_with_help", "with help"],
  ["abandoned", "abandoned"],
] as const;

/** `inferred endings · 341 autonomous, 74 with help, 6 abandoned` — never ground truth. */
function inferredEndingsNote(analysis: SessionAnalysis): DeliveryNote | undefined {
  const byStatus = new Map<string, number>();
  for (const session of analysis.sessions) {
    const status = session.inferredOutcome?.status;
    if (status !== undefined) {
      byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    }
  }
  const parts: string[] = [];
  for (const [status, label] of ENDING_LABELS) {
    const value = byStatus.get(status) ?? 0;
    if (value > 0) {
      parts.push(`${value} ${label}`);
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  return { label: "Inferred endings", value: parts.join(" · ") };
}

/** One bar per (command, subcommand) identity, so `git diff` shows up apart from `git push`. */
export function commandChart(analysis: SessionAnalysis, columns: number): readonly string[] {
  const byLabel = new Map<string, { calls: number; durationMs: number; failures: number }>();
  for (const session of analysis.sessions) {
    for (const command of session.commands) {
      const label = commandLabel(command);
      const entry = byLabel.get(label) ?? { calls: 0, durationMs: 0, failures: 0 };
      entry.calls += command.calls;
      entry.durationMs += command.durationMs;
      entry.failures += command.failures;
      byLabel.set(label, entry);
    }
  }
  if (byLabel.size === 0) {
    return [];
  }
  const rows = [...byLabel.entries()].sort(
    ([leftLabel, left], [rightLabel, right]) =>
      right.durationMs - left.durationMs ||
      right.calls - left.calls ||
      leftLabel.localeCompare(rightLabel),
  );
  const shown = rows.slice(0, COMMAND_LIMIT);
  const widest = Math.max(...shown.map(([, entry]) => entry.durationMs), 1);
  const barWidth = columns >= 60 ? 20 : 8;
  const lines = ["", "  Commands by tool time"];
  for (const [label, entry] of shown) {
    lines.push(
      `    ${chartLabel(safe(label))}  ${bar(entry.durationMs / widest, barWidth)}  ${duration(entry.durationMs)}`,
    );
    const failed =
      entry.failures > 0 ? ` · ${percent(ratio(entry.failures, entry.calls))} failed` : "";
    lines.push(...wrappedRow(`${count(entry.calls, "call")}${failed}`, "      ", columns));
  }
  if (rows.length > shown.length) {
    lines.push(
      ...wrappedRow(
        `and ${count(rows.length - shown.length, "more command identity", "more command identities")} · --json lists every one`,
        "    ",
        columns,
      ),
    );
  }
  return lines;
}

function commandLabel(command: {
  readonly command: string | undefined;
  readonly subcommand: string | undefined;
  readonly tool: string;
}): string {
  if (command.command === undefined) {
    return command.tool;
  }
  return command.subcommand === undefined
    ? command.command
    : `${command.command} ${command.subcommand}`;
}

/** The loose work-item join: sessions that named the same issue key, busiest first. */
export function workItemSection(analysis: SessionAnalysis, columns: number): readonly string[] {
  const shown = analysis.workItems.slice(0, WORK_ITEM_LIMIT);
  if (shown.length === 0) {
    return [];
  }
  const lines = [
    "",
    ...wrappedRow(
      "Work items · keys seen in prompts, branches, and git/gh commands",
      "  ",
      columns,
    ),
  ];
  for (const item of shown) {
    lines.push(
      `    ${chartLabel(safe(item.key))}  ${duration(item.wallClockMs)} agent time`,
      ...wrappedRow(count(item.sessions, "session"), "      ", columns),
      ...wrappedRow(`${duration(item.spanMs)} first-to-last`, "      ", columns),
    );
  }
  if (analysis.workItems.length > shown.length) {
    lines.push(
      ...wrappedRow(
        `and ${count(analysis.workItems.length - shown.length, "more work item")} · --json lists every one`,
        "    ",
        columns,
      ),
    );
  }
  return lines;
}

function wrappedRow(text: string, indent: string, columns: number): readonly string[] {
  return wrapWords(text, Math.max(1, columns - indent.length)).map((line) => `${indent}${line}`);
}
