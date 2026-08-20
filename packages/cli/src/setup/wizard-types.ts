/** One decoded key, however the terminal happened to encode it. */
export interface Keypress {
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly name: string | undefined;
  readonly sequence: string | undefined;
  readonly shift: boolean;
}

/** One selectable row of a wizard question. */
export interface WizardOption {
  /** One dim line of context rendered under the label. */
  readonly description?: string | undefined;
  /** Visible but not selectable. */
  readonly disabled?: boolean | undefined;
  /** Why a disabled row is disabled; replaces the default `unavailable` suffix on its label. */
  readonly disabledNote?: string | undefined;
  /** Optional heading rendered before the first adjacent option in this group. */
  readonly group?: string | undefined;
  readonly label: string;
  /**
   * Fetches the preview content on demand, for rows whose content is remote.
   *
   * Consulted only when `preview` is absent and only when the user presses `p` on the row: the
   * overlay opens on a loading notice and repaints with what this resolves. The provider is
   * expected to memoize, so reading a preview here never costs the later install a second fetch.
   * A rejection renders a generic failure notice — never raw error text.
   */
  readonly loadPreview?: (() => Promise<string>) | undefined;
  /**
   * Settled: the row renders as it stands and neither space nor its digit ever moves its checkbox.
   *
   * Stronger than `disabled`, which refuses only the marking direction so a seeded selection can
   * always be given up. A locked row states something the form is not asking about — a record Aura
   * has no way to act on either way — so both directions are refused and the cursor skips it.
   *
   * A locked row carries no number either: numbers are what digits address, and addressing a row
   * whose every direction is refused would spend a digit on nothing. It renders `✔` rather than a
   * checkbox for the same reason — a box invites the space press that a lock then swallows.
   *
   * That `✔` comes from the lock alone and never from {@link WizardQuestion.initial}: it reports
   * settled state rather than what this run marked, so a caller that seeds the value and one that
   * does not draw the same row. Answer summaries leave locked rows out for the same reason.
   */
  readonly locked?: boolean | undefined;
  /**
   * Values this row checks and clears as a group instead of selecting its own.
   *
   * Makes the row a gesture over other rows — a skill pack — rather than an answer: its own
   * `value` never enters the selection, marking it adds every member (or clears them all when
   * every one is already checked), and each member row remains individually toggleable
   * afterwards. Its checkbox renders derived state: none, some (`◪`), or all of its members.
   */
  readonly members?: readonly string[] | undefined;
  /**
   * Dim ` · <note>` trailing the label: where the row sits, not why it cannot be marked.
   *
   * Earns its place on a row pulled out of its own group — a record block gathered from several
   * categories — where the heading above it no longer says where it came from. `disabledNote` is
   * the other half of the pair and reports the opposite: why a visible row refuses a mark.
   */
  readonly note?: string | undefined;
  /** Full multi-line content shown by the interactive preview action. */
  readonly preview?: string | undefined;
  /**
   * Dim ` (Recommended)` trailing the label: the answer Aura would pick if it picked for you.
   *
   * Only ever the row this question already proposes — the one {@link WizardQuestion.initial}
   * selects, which is also what `--yes` takes. Marking any other row would advertise an answer no
   * unattended run would reach, and would leave the open form recommending one row while standing
   * on another.
   *
   * A recommended row leads its menu, which {@link recommendedFirst} is how callers get; row `1.`
   * is where a reader looks first and where the cursor already sits.
   */
  readonly recommended?: boolean | undefined;
  readonly value: string;
}

/** One question tab of a wizard form. */
export interface WizardQuestion {
  /** Shorter tab-bar label used when the full labels would overflow the terminal. */
  readonly compactLabel?: string | undefined;
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
  /** Draft seeded into the free-text row when the form opens; how a text answer is re-seeded. */
  readonly initialText?: string | undefined;
  readonly kind: "multiselect" | "select";
  /** Short name shown in the tab bar. */
  readonly label: string;
  readonly options: readonly WizardOption[];
  /** Full question shown above the options. */
  readonly prompt: string;
  /** Enables an in-place `/` search, with only this many options shown before a query is entered. */
  readonly search?:
    | {
        readonly initialLimit: number;
        readonly placeholder: string;
      }
    | undefined;
  /** Repaints the open form when externally owned option state changes. */
  readonly subscribe?: ((repaint: () => void) => () => void) | undefined;
}

export type WizardAnswer =
  | { readonly kind: "options"; readonly values: readonly string[] }
  | { readonly kind: "text"; readonly text: string };

/** Answers keyed by question id. */
export type WizardAnswers = Readonly<Record<string, WizardAnswer>>;

/**
 * `"back"` is the user backing out of the form to the one before it (← past the first tab); only
 * forms given a {@link WizardFlowContext} with something before them can resolve with it.
 */
export type WizardFormResult = WizardAnswers | "aborted" | "back";

export type WizardConfirmation = "accepted" | "aborted" | "back" | "declined";

/** One independently loaded resource shown in a wizard loading frame. */
export interface WizardLoadItem {
  readonly id: string;
  readonly label: string;
}

export interface WizardLoadRequest {
  readonly items: readonly WizardLoadItem[];
  readonly prompt: string;
}

export type WizardLoadStatus = "active" | "complete";

/** Updates one loading row without exposing terminal rendering to the task doing the work. */
export type WizardLoadUpdate = (id: string, status: WizardLoadStatus) => void;

/** One surrounding-flow step shown in the tab bar around the live form. */
export interface WizardFlowStep {
  /** Shorter tab-bar label used when the full labels would overflow the terminal. */
  readonly compactLabel?: string | undefined;
  readonly label: string;
}

/** The active step's internal chain progress, rendered as an indented sub-row under the bar. */
interface WizardFlowSubContext {
  readonly completed: readonly WizardFlowStep[];
  readonly upcoming: readonly WizardFlowStep[];
}

/**
 * Where one form sits in the wizard's overall flow.
 *
 * The tab bar must map the whole flow, not just the live form (docs/cli-ux.md). With `step` set,
 * the top row is a static map of the real steps — completed `✔`, the active step `▶`, the rest
 * pending — and the live form's questions render only in the `└` sub-row, framed by `sub`'s
 * chain progress. With `step` absent, the questions splice into the top row at the flow position,
 * which is also how the Submit confirmation's question stands in for the Submit tab. A form given
 * a flow has no review tab of its own — the trailing Submit belongs to the flow, and answering
 * the form's last question resolves it.
 */
export interface WizardFlowContext {
  readonly completed: readonly WizardFlowStep[];
  /** The active step's own tab; absent on the final Submit confirmation and on legacy forms. */
  readonly step?: WizardFlowStep | undefined;
  /** Chain progress around the live form's questions; presence alone does not force a sub-row. */
  readonly sub?: WizardFlowSubContext | undefined;
  /**
   * This form is the flow's final Submit action: its tab renders label-only, like the Submit tab
   * it stands in for, and no extra Submit is appended after the upcoming steps.
   */
  readonly submit?: boolean | undefined;
  readonly upcoming: readonly WizardFlowStep[];
}

/**
 * The one seam between wizard flow and terminal interaction.
 *
 * Steps and the orchestrator talk to this interface only, so the whole wizard runs headless under
 * a scripted implementation and tests never synthesize keypresses.
 */
export interface WizardIo {
  /** Runs one tabbed form and resolves with an answer per question. */
  readonly ask: (
    questions: readonly WizardQuestion[],
    flow?: WizardFlowContext,
  ) => Promise<WizardFormResult>;
  /** Asks for one final go-ahead. */
  readonly confirm: (prompt: string, flow?: WizardFlowContext) => Promise<WizardConfirmation>;
  /** Keeps the flow frame visible while an asynchronous task reports item-level progress. */
  readonly load: <T>(
    request: WizardLoadRequest,
    task: (update: WizardLoadUpdate) => Promise<T>,
    flow?: WizardFlowContext,
  ) => Promise<T>;
  /** Shows one line of progress or context outside any form. */
  readonly note: (text: string) => void;
}

/** The answer a question proposes on its own, used by `--yes` and untouched forms. */
export function defaultAnswer(question: WizardQuestion): WizardAnswer {
  if (question.initial !== undefined) {
    return { kind: "options", values: question.initial };
  }
  if (question.freeText === true && question.options.length === 0) {
    return { kind: "text", text: question.initialText ?? "" };
  }
  if (question.kind === "select") {
    const first = question.options[0];
    return { kind: "options", values: first === undefined ? [] : [first.value] };
  }
  return { kind: "options", values: [] };
}

/**
 * The same rows with any recommended one hoisted to the top, keeping the rest in order.
 *
 * The advice and the row it sits on move together: a menu that recommends row 3 makes the reader
 * find what it already decided for them, and reads as an afterthought next to the option it
 * ordered first. Hoisting rather than sorting keeps whatever ordering the caller built underneath
 * — least invasive first, opt-out last — intact for every other row.
 */
export function recommendedFirst(options: readonly WizardOption[]): readonly WizardOption[] {
  const index = options.findIndex((option) => option.recommended === true);
  const lead = index <= 0 ? undefined : options[index];
  if (lead === undefined) {
    return options;
  }
  return [lead, ...options.filter((_, at) => at !== index)];
}

/** The option values one answer selected, empty for free text or a missing answer. */
export function selectedValues(answer: WizardAnswer | undefined): readonly string[] {
  return answer === undefined || answer.kind !== "options" ? [] : answer.values;
}

/**
 * Folds one review form's answers back into the decisions carried by a chain's state.
 *
 * Review forms are keyed `<prefix><identity>` so a single form can carry one question per item.
 * Answers already given for items this form did not ask about are kept: a stage re-entered through
 * ← re-asks a subset, and dropping the rest would silently reset decisions the user already made.
 */
export function foldDecisions(
  previous: Readonly<Record<string, string>>,
  answers: WizardAnswers,
  prefix: string,
  fallback: string,
): Readonly<Record<string, string>> {
  const decisions = { ...previous };
  for (const [id, answer] of Object.entries(answers)) {
    if (id.startsWith(prefix)) {
      decisions[id.slice(prefix.length)] = selectedValues(answer)[0] ?? fallback;
    }
  }
  return decisions;
}
