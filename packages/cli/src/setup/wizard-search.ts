import type { WizardOption } from "./wizard-types.js";

/**
 * The most matching rows one query renders.
 *
 * A one-letter query over a thousand-skill catalog matches most of it, and rendering every hit
 * makes the clip window measure hundreds of wrapped rows to show a screenful. The search line
 * still names the full total, so nothing is hidden silently — narrowing the query is how the tail
 * is reached.
 */
export const SEARCH_RESULT_CAP = 50;

/** The ranked rows a query keeps, and how many matched before the cap. */
export interface SearchOutcome {
  readonly matched: readonly WizardOption[];
  readonly total: number;
}

/** One option's lowercased fields, built once per option list rather than per keystroke. */
interface Haystack {
  readonly description: string;
  readonly group: string;
  readonly label: string;
  readonly value: string;
}

const HAYSTACKS = new WeakMap<readonly WizardOption[], readonly Haystack[]>();

/**
 * Ranks the options matching every term of `query`, best match first.
 *
 * Every whitespace-separated term must match somewhere — the same AND the plain filter had — but
 * hits are scored: a word at the start of the label beats a substring inside it, which beats a hit
 * in the id, the group, or the description. Ties keep display order, so equally scored rows never
 * jump around as the query grows.
 */
export function searchOptions(options: readonly WizardOption[], query: string): SearchOutcome {
  const terms = searchTerms(query);
  if (terms.length === 0) {
    return { matched: options.slice(0, SEARCH_RESULT_CAP), total: options.length };
  }
  const fields = haystacksFor(options);
  const scored: {
    readonly index: number;
    readonly option: WizardOption;
    readonly score: number;
  }[] = [];
  options.forEach((option, index) => {
    const haystack = fields[index];
    if (haystack === undefined) {
      return;
    }
    const score = scoreOption(haystack, terms);
    if (score !== undefined) {
      scored.push({ index, option, score });
    }
  });
  scored.sort((a, b) => (a.score === b.score ? a.index - b.index : b.score - a.score));
  return {
    matched: scored.slice(0, SEARCH_RESULT_CAP).map(({ option }) => option),
    total: scored.length,
  };
}

/** The query's lowercased terms, in match order. */
export function searchTerms(query: string): readonly string[] {
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter((term) => term !== "");
}

/**
 * Bolds every term's matched spans inside an already-sanitized label.
 *
 * Takes the label after `safe()` on purpose: highlighting has to find the same bytes the renderer
 * prints, and sanitizing afterwards would strip the styling this adds. Overlapping term spans are
 * merged so nested escape sequences never interleave.
 */
export function highlightLabel(
  label: string,
  terms: readonly string[],
  bold: (text: string) => string,
): string {
  const lower = label.toLocaleLowerCase();
  const spans: { start: number; end: number }[] = [];
  for (const term of terms) {
    const start = lower.indexOf(term);
    if (start >= 0) {
      spans.push({ end: start + term.length, start });
    }
  }
  if (spans.length === 0) {
    return label;
  }
  spans.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last !== undefined && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  let cursor = 0;
  let output = "";
  for (const span of merged) {
    output += label.slice(cursor, span.start) + bold(label.slice(span.start, span.end));
    cursor = span.end;
  }
  return output + label.slice(cursor);
}

function haystacksFor(options: readonly WizardOption[]): readonly Haystack[] {
  const cached = HAYSTACKS.get(options);
  if (cached !== undefined) {
    return cached;
  }
  const built = options.map((option): Haystack => ({
    description: (option.description ?? "").toLocaleLowerCase(),
    group: (option.group ?? "").toLocaleLowerCase(),
    label: option.label.toLocaleLowerCase(),
    value: option.value.toLocaleLowerCase(),
  }));
  HAYSTACKS.set(options, built);
  return built;
}

/** The summed field scores, or `undefined` when any term matches nothing. */
function scoreOption(haystack: Haystack, terms: readonly string[]): number | undefined {
  let total = 0;
  for (const term of terms) {
    const score = scoreTerm(haystack, term);
    if (score === undefined) {
      return undefined;
    }
    total += score;
  }
  return total;
}

function scoreTerm(haystack: Haystack, term: string): number | undefined {
  const labelIndex = haystack.label.indexOf(term);
  if (labelIndex >= 0) {
    return atWordStart(haystack.label, labelIndex) ? 8 : 5;
  }
  if (haystack.value.includes(term)) {
    return 3;
  }
  if (haystack.group.includes(term)) {
    return 2;
  }
  if (haystack.description.includes(term)) {
    return 1;
  }
  return undefined;
}

function atWordStart(text: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  const before = text[index - 1];
  return before !== undefined && !/[\p{L}\p{N}]/u.test(before);
}
