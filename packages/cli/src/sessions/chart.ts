import { GRAPHEME_SEGMENTER } from "../safe-text.js";
import { displayWidth } from "../text-width.js";

/**
 * Drawing and formatting primitives for the sessions report: bars, grades, and the number
 * formats the rows share. Presentation policy — which metrics exist, their thresholds, their
 * wording — stays in `render.ts`; this file only knows how to draw.
 */

/** Width of the label column in bar charts; longer names truncate with an ellipsis. */
const CHART_LABEL_WIDTH = 16;

/** Cells in a normal bar; each cell subdivides into eighths. */
const BAR_WIDTH = 20;

/** Fixed card geometry: four cards plus gaps and the report indent occupy 77 columns. */
const CARD_WIDTH = 18;
const CARD_INNER_WIDTH = CARD_WIDTH - 2;
const CARD_GAP = " ";

export interface MetricCard {
  readonly detail: string;
  readonly title: string;
  readonly value: string;
}

const PARTIAL_BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

const GRADES = ["A", "B", "C", "D", "F"] as const;
export type Grade = (typeof GRADES)[number];

/** Upper bounds a value must stay below for A, B, C, and D; at or past the last is an F. */
export type GradeBands = readonly [number, number, number, number];

export function gradeOf(value: number, bands: GradeBands): Grade {
  const passed = bands.filter((bound) => value >= bound).length;
  return GRADES[passed] ?? "F";
}

/** A filled-over-track bar for a 0..1 fraction: `███▍░░…`. Nonzero always shows some ink. */
export function bar(fraction: number, width = BAR_WIDTH): string {
  const cells = Math.min(Math.max(fraction, 0), 1) * width;
  let full = Math.floor(cells);
  let eighths = Math.round((cells - full) * 8);
  if (eighths === 8) {
    full += 1;
    eighths = 0;
  }
  if (full === 0 && eighths === 0 && fraction > 0) {
    eighths = 1;
  }
  const filled = "█".repeat(full) + (PARTIAL_BLOCKS[eighths] ?? "");
  return filled + "░".repeat(width - full - (eighths > 0 ? 1 : 0));
}

/** Four compact metric cards at normal widths, or a 2×2 grid at the 40-column floor. */
export function metricCards(cards: readonly MetricCard[], columns: number): readonly string[] {
  const perRow = columns >= 77 ? 4 : 2;
  const rendered = cards.map(renderMetricCard);
  const lines: string[] = [];
  for (let start = 0; start < rendered.length; start += perRow) {
    const group = rendered.slice(start, start + perRow);
    for (let row = 0; row < 4; row += 1) {
      lines.push(`  ${group.map((card) => card[row] ?? "").join(CARD_GAP)}`);
    }
  }
  return lines;
}

function renderMetricCard(card: MetricCard): readonly string[] {
  const title = fitCell(card.title, CARD_INNER_WIDTH - 2).trimEnd();
  const rule = "─".repeat(Math.max(0, CARD_INNER_WIDTH - displayWidth(title) - 2));
  return [
    `┌ ${title} ${rule}┐`,
    `│${fitCell(card.value, CARD_INNER_WIDTH)}│`,
    `│${fitCell(card.detail, CARD_INNER_WIDTH)}│`,
    `└${"─".repeat(CARD_INNER_WIDTH)}┘`,
  ];
}

/** Fits one value by terminal cells and keeps a final ellipsis when content is too wide. */
function fitCell(value: string, width: number): string {
  if (displayWidth(value) <= width) {
    return `${value}${" ".repeat(width - displayWidth(value))}`;
  }
  let fitted = "";
  let fittedWidth = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
    const segmentWidth = displayWidth(segment);
    if (fittedWidth + segmentWidth + 1 > width) {
      break;
    }
    fitted += segment;
    fittedWidth += segmentWidth;
  }
  return `${fitted}…${" ".repeat(Math.max(0, width - fittedWidth - 1))}`;
}

export function chartLabel(name: string): string {
  if (name.length <= CHART_LABEL_WIDTH) {
    return name.padEnd(CHART_LABEL_WIDTH);
  }
  return `${name.slice(0, CHART_LABEL_WIDTH - 1)}…`;
}

export function percent(fraction: number): string {
  const value = fraction * 100;
  if (value > 0 && value < 1) {
    return "<1%";
  }
  return `${Math.round(value)}%`;
}

export function ratio(part: number, whole: number): number {
  return whole <= 0 ? 0 : part / whole;
}

export function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${grouped(value)} ${value === 1 ? singular : plural}`;
}

/** `987`, `61.2k`, `4.1M`, `2.3B` — token volumes, where magnitude matters and digits do not. */
export function compactCount(value: number): string {
  const scaled = (unit: number) => {
    const amount = value / unit;
    return amount >= 100 ? String(Math.round(amount)) : amount.toFixed(1).replace(/\.0$/u, "");
  };
  if (value >= 1e9) {
    return `${scaled(1e9)}B`;
  }
  if (value >= 1e6) {
    return `${scaled(1e6)}M`;
  }
  if (value >= 1000) {
    return `${scaled(1000)}k`;
  }
  return String(value);
}

function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+$)/gu, ",");
}

/** The middle value of a sample; undefined when the sample is empty. */
export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** `2h 14m`, `3m 12s`, `45s` — coarse on purpose: this is a summary, not a profile. */
export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds - minutes * 60}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
