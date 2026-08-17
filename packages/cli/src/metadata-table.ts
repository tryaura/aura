import type { Finding, FindingMetadataTableColumn } from "@tryaura/aura-sdk";
import { pluralize } from "@tryaura/core/pluralize";
import stringWidth from "string-width";

import { GRAPHEME_SEGMENTER, safeFindingText } from "./safe-text.js";

/**
 * How many rows one metadata table prints before the rest are summarized.
 *
 * A table is drawn from metadata a check assembled out of the repository the user checked out, so
 * its length is bounded by that repository rather than by anything Aura decided. A check is
 * expected to bound its own rows, and this is the backstop for the one that does not: a report
 * that scrolls a terminal for a minute is no longer a report.
 */
const MAX_TABLE_ROWS = 100;
const MAX_TABLE_COLUMN_WIDTH = 80;
const ELLIPSIS = "…";

/** Draws the table a finding asked for, or nothing at all if it asked for none it can fill. */
export function renderFindingPresentation(
  finding: Pick<Finding, "metadata" | "presentation">,
): readonly string[] {
  const presentation = finding.presentation;
  if (presentation?.kind !== "metadata-table" || presentation.columns.length === 0) {
    return [];
  }
  const rows = finding.metadata?.[presentation.rowsKey];
  if (!Array.isArray(rows)) {
    return [];
  }
  const records = rows.filter(isRecord);
  if (records.length === 0) {
    return [];
  }

  const shown = records.slice(0, MAX_TABLE_ROWS);
  const omitted = records.length - shown.length;
  const headings = presentation.columns.map((column) =>
    fitTableCell(safeFindingText(column.heading)),
  );
  const cells = shown.map((row) =>
    presentation.columns.map((column) =>
      fitTableCell(safeFindingText(formatMetadataCell(row[column.key], column))),
    ),
  );
  const widths = presentation.columns.map((_, index) =>
    cells.reduce(
      (widest, row) => Math.max(widest, displayWidth(row[index] ?? "")),
      displayWidth(headings[index] ?? ""),
    ),
  );

  return [
    renderTableRow(headings, presentation.columns, widths),
    renderTableRow(
      widths.map((width) => "-".repeat(width)),
      presentation.columns,
      widths,
    ),
    ...cells.map((row) => renderTableRow(row, presentation.columns, widths)),
    ...(omitted === 0 ? [] : [`… ${String(omitted)} more ${pluralize(omitted, "row")} not shown`]),
  ];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatMetadataCell(value: unknown, column: FindingMetadataTableColumn): string {
  const format = column.format ?? "text";
  if (format === "boolean") {
    return formatBooleanCell(value, column);
  }
  if (format === "integer") {
    return formatIntegerCell(value);
  }
  if (format === "percentage") {
    return formatPercentageCell(value);
  }
  return formatTextCell(value);
}

function formatBooleanCell(value: unknown, column: FindingMetadataTableColumn): string {
  if (value === true) {
    return column.trueLabel ?? "true";
  }
  if (value === false) {
    return column.falseLabel ?? "false";
  }
  return "";
}

function formatIntegerCell(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value).toLocaleString("en-US")
    : "";
}

function formatPercentageCell(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "";
}

function formatTextCell(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}

function renderTableRow(
  cells: readonly string[],
  columns: readonly FindingMetadataTableColumn[],
  widths: readonly number[],
): string {
  return cells
    .map((cell, index) => padCell(cell, widths[index] ?? 0, columns[index]?.align === "right"))
    .join("  ")
    .trimEnd();
}

function fitTableCell(value: string): string {
  if (displayWidth(value) <= MAX_TABLE_COLUMN_WIDTH) {
    return value;
  }

  const contentWidth = MAX_TABLE_COLUMN_WIDTH - displayWidth(ELLIPSIS);
  let fitted = "";
  let fittedWidth = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
    const segmentWidth = displayWidth(segment);
    if (fittedWidth + segmentWidth > contentWidth) {
      break;
    }
    fitted += segment;
    fittedWidth += segmentWidth;
  }
  return `${fitted}${ELLIPSIS}`;
}

function padCell(value: string, width: number, rightAligned: boolean): string {
  const padding = " ".repeat(Math.max(0, width - displayWidth(value)));
  return rightAligned ? `${padding}${value}` : `${value}${padding}`;
}

function displayWidth(value: string): number {
  return stringWidth(value);
}
