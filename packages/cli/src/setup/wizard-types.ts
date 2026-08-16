/** One selectable row of a wizard question. */
export interface WizardOption {
  /** One dim line of context rendered under the label. */
  readonly description?: string | undefined;
  /** Visible but not selectable. */
  readonly disabled?: boolean | undefined;
  /** Optional heading rendered before the first adjacent option in this group. */
  readonly group?: string | undefined;
  readonly label: string;
  /** Full multi-line content shown by the interactive preview action. */
  readonly preview?: string | undefined;
  readonly value: string;
}

/** One question tab of a wizard form. */
export interface WizardQuestion {
  /** Offers a trailing free-text row after the options. */
  readonly freeText?: boolean | undefined;
  readonly id: string;
  /**
   * Values selected when the form opens.
   *
   * Doubles as the scripted answer: `--yes` and a non-interactive dry run take every question's
   * initial selection, so what they accept is exactly what the form would have proposed.
   */
  readonly initial?: readonly string[] | undefined;
  readonly kind: "multiselect" | "select";
  /** Short name shown in the tab bar. */
  readonly label: string;
  readonly options: readonly WizardOption[];
  /** Full question shown above the options. */
  readonly prompt: string;
}

export type WizardAnswer =
  | { readonly kind: "options"; readonly values: readonly string[] }
  | { readonly kind: "text"; readonly text: string };

/** Answers keyed by question id. */
export type WizardAnswers = Readonly<Record<string, WizardAnswer>>;

export type WizardFormResult = WizardAnswers | "aborted";

export type WizardConfirmation = "accepted" | "aborted" | "declined";

/**
 * The one seam between wizard flow and terminal interaction.
 *
 * Steps and the orchestrator talk to this interface only, so the whole wizard runs headless under
 * a scripted implementation and tests never synthesize keypresses.
 */
export interface WizardIo {
  /** Runs one tabbed form and resolves with an answer per question. */
  readonly ask: (questions: readonly WizardQuestion[]) => Promise<WizardFormResult>;
  /** Asks for one final go-ahead. */
  readonly confirm: (prompt: string) => Promise<WizardConfirmation>;
  /** Shows one line of progress or context outside any form. */
  readonly note: (text: string) => void;
}

/** The answer a question proposes on its own, used by `--yes` and untouched forms. */
export function defaultAnswer(question: WizardQuestion): WizardAnswer {
  if (question.initial !== undefined) {
    return { kind: "options", values: question.initial };
  }
  if (question.kind === "select") {
    const first = question.options[0];
    return { kind: "options", values: first === undefined ? [] : [first.value] };
  }
  return { kind: "options", values: [] };
}

/** The option values one answer selected, empty for free text or a missing answer. */
export function selectedValues(answer: WizardAnswer | undefined): readonly string[] {
  return answer === undefined || answer.kind !== "options" ? [] : answer.values;
}
