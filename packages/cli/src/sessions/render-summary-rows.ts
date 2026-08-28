import type { SessionAnalysis } from "@tryaura/core";

import { count } from "./chart.js";
import { wrapWords } from "../text-width.js";

/**
 * Label/value rows shared by the summary sections. Split from `render-overall.ts` only for the
 * file-size cap; the wording is one surface with the rest of the report.
 */
export function summaryRow(label: string, value: string, columns: number): readonly string[] {
  const indent = "    ";
  const labelWidth = 18;
  const prefix = `${indent}${label.padEnd(labelWidth)}`;
  const continuation = " ".repeat(prefix.length);
  return wrapWords(value, Math.max(16, columns - prefix.length)).map(
    (line, index) => `${index === 0 ? prefix : continuation}${line}`,
  );
}

export function coverageRows(analysis: SessionAnalysis, columns: number): readonly string[] {
  const rows: string[] = [];
  if (analysis.unreadableFiles > 0) {
    rows.push(
      ...summaryRow("Unreadable", count(analysis.unreadableFiles, "transcript file"), columns),
    );
  }
  if (analysis.partialFiles > 0) {
    rows.push(
      ...summaryRow("Incomplete", count(analysis.partialFiles, "transcript file"), columns),
    );
  }
  if (analysis.malformedLines > 0) {
    rows.push(...summaryRow("Malformed lines", String(analysis.malformedLines), columns));
  }
  if (analysis.invalidValues > 0) {
    rows.push(...summaryRow("Invalid values", String(analysis.invalidValues), columns));
  }
  if (analysis.readErrorFiles > 0) {
    rows.push(...summaryRow("Read failures", String(analysis.readErrorFiles), columns));
  }
  return rows;
}

/** Human steering, one short row per kind instead of one packed sentence. */
export function interventionRows(analysis: SessionAnalysis, columns: number): readonly string[] {
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
