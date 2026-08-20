import type { Keypress, WizardOption, WizardQuestion } from "./wizard-types.js";

/** The tab-focus movement a key asks for, or undefined when it is not a tab key. */
export function tabDelta(keypress: Keypress): number | undefined {
  if (keypress.name === "left") {
    return -1;
  }
  // Shift-tab arrives as a "tab" keypress with the shift flag set, and moves focus backward.
  if (keypress.name === "tab") {
    return keypress.shift ? -1 : 1;
  }
  if (keypress.name === "right") {
    return 1;
  }
  return undefined;
}

function rowCount(question: WizardQuestion, optionCount = question.options.length): number {
  return optionCount + (question.freeText === true ? 1 : 0);
}

/**
 * The row ↑/↓ lands on, stepping over locked rows the way the opening cursor already skips them.
 *
 * A locked row refuses every key that acts on a row, so resting the cursor there would leave the
 * reader pointing at nothing they can do — and `❯` would claim otherwise. Disabled rows still take
 * the cursor: a mark seeded before the source went away can be given up there. A screen with
 * nothing but locked rows has nowhere to step to and keeps the cursor where it is.
 */
export function moveCursor(
  question: WizardQuestion,
  options: readonly WizardOption[],
  from: number,
  delta: number,
): number {
  const rows = rowCount(question, options.length);
  if (rows === 0) {
    return from;
  }
  for (let step = 1; step <= rows; step += 1) {
    const row = (((from + delta * step) % rows) + rows) % rows;
    // A row past the options is the free-text one, which no lock ever covers.
    if (options[row]?.locked !== true) {
      return row;
    }
  }
  return from;
}

/**
 * The rows that carry a printed number, in the order those numbers run.
 *
 * The renderer numbers from this list and digits address it, so the two can never drift: what the
 * screen calls `3` is what `3` jumps to. Locked rows are skipped — a number is an offer to act,
 * and a row that refuses every direction has nothing to offer — which also means installing a
 * snippet renumbers the rows below it, exactly as removing one from the catalog would.
 */
export function numberedRows(
  question: WizardQuestion,
  options: readonly WizardOption[] = question.options,
): readonly number[] {
  const rows = options.flatMap((option, index) => (option.locked === true ? [] : [index]));
  return question.freeText === true ? [...rows, options.length] : rows;
}

/**
 * Whether space would still act on some row of the screen.
 *
 * A locked row refuses both directions, and a disabled one refuses only the marking direction — so
 * a screen of nothing but those has one case left: a disabled row that opens marked can still be
 * given up. An empty option list belongs to a free-text or search question whose rows are not the
 * point yet, and keeps the key.
 */
export function markable(options: readonly WizardOption[], selected: ReadonlySet<string>): boolean {
  return (
    options.length === 0 ||
    options.some(
      (option) =>
        option.locked !== true && (option.disabled !== true || selected.has(option.value)),
    )
  );
}

/** The row a typed digit addresses, counting the free-text row as the last numbered one. */
export function digitRow(
  keypress: Keypress,
  question: WizardQuestion,
  options: readonly WizardOption[] = question.options,
): number | undefined {
  if (keypress.sequence === undefined || !/^[1-9]$/u.test(keypress.sequence)) {
    return undefined;
  }
  return numberedRows(question, options)[Number(keypress.sequence) - 1];
}

export function printable(keypress: Keypress): string | undefined {
  if (keypress.ctrl || keypress.meta || keypress.sequence === undefined) {
    return undefined;
  }
  const code = keypress.sequence.codePointAt(0) ?? 0;
  return [...keypress.sequence].length === 1 && code >= 0x20 && code !== 0x7f
    ? keypress.sequence
    : undefined;
}
