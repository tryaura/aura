/**
 * Drawing and formatting primitives for the sessions report: bars, grades, and the number
 * formats the rows share. Presentation policy — which metrics exist, their thresholds, their
 * wording — stays in `render.ts`; this file only knows how to draw.
 */

/** Width of the label column in bar charts; longer names truncate with an ellipsis. */
const CHART_LABEL_WIDTH = 16;

/** Cells in a bar; each cell subdivides into eighths, so a 20-cell bar resolves 0.6%. */
const BAR_WIDTH = 20;

const PARTIAL_BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

const GRADES = ["A", "B", "C", "D", "F"] as const;
export type Grade = (typeof GRADES)[number];

/** Upper bounds a value must stay below for A, B, C, and D; at or past the last is an F. */
export type GradeBands = readonly [number, number, number, number];

export function gradeOf(value: number, bands: GradeBands): Grade {
  const passed = bands.filter((bound) => value >= bound).length;
  return GRADES[passed] ?? "F";
}

/** Grades roll up pessimistically: a section is only as healthy as its worst signal. */
export function worstGrade(grades: readonly Grade[]): Grade {
  return grades.reduce((worst, grade) =>
    GRADES.indexOf(grade) > GRADES.indexOf(worst) ? grade : worst,
  );
}

/** A filled-over-track bar for a 0..1 fraction: `███▍░░…`. Nonzero always shows some ink. */
export function bar(fraction: number): string {
  const cells = Math.min(Math.max(fraction, 0), 1) * BAR_WIDTH;
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
  return filled + "░".repeat(BAR_WIDTH - full - (eighths > 0 ? 1 : 0));
}

/** `label ███░… annotation`, labels padded so bars align into one column. */
export function gaugeRow(label: string, fraction: number, annotation: string): string {
  return `${label.padEnd(11)}${bar(fraction)}  ${annotation}`;
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
