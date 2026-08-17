import type { Keypress, WizardQuestion } from "./wizard-types.js";

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

export function rowCount(question: WizardQuestion): number {
  return question.options.length + (question.freeText === true ? 1 : 0);
}

/** The row a typed digit addresses, counting the free-text row as the last one. */
export function digitRow(keypress: Keypress, question: WizardQuestion): number | undefined {
  if (keypress.sequence === undefined || !/^[1-9]$/u.test(keypress.sequence)) {
    return undefined;
  }
  const row = Number(keypress.sequence) - 1;
  return row < rowCount(question) ? row : undefined;
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
