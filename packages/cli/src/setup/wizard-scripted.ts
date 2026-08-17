import type { Writable } from "node:stream";

import { safe } from "../safe-text.js";
import {
  defaultAnswer,
  type WizardAnswer,
  type WizardAnswers,
  type WizardConfirmation,
  type WizardFormResult,
  type WizardIo,
} from "./wizard-types.js";

/** What one scripted `ask` call resolves with; omitted question ids take their default answer. */
type ScriptedFormResponse = WizardAnswers | "aborted";

export interface ScriptedWizardScript {
  /** Consumed one per `confirm` call; an exhausted script accepts. */
  readonly confirmations?: readonly WizardConfirmation[] | undefined;
  /** Consumed one per `ask` call; an exhausted script answers every question with its default. */
  readonly forms?: readonly ScriptedFormResponse[] | undefined;
  /** Where notes go; they are collected either way. */
  readonly output?: Writable | undefined;
}

export interface ScriptedWizardIo extends WizardIo {
  /** Every note the flow emitted, in order. */
  readonly notes: readonly string[];
}

/**
 * A {@link WizardIo} fed answers programmatically, so the whole wizard runs headless.
 *
 * This is both the test harness and the production `--yes` path: with an empty script every
 * question resolves to its declared default and every confirmation is accepted, which makes
 * "what `--yes` does" and "what the form proposes" the same thing by construction.
 */
export function createScriptedWizardIo(script: ScriptedWizardScript = {}): ScriptedWizardIo {
  const forms = [...(script.forms ?? [])];
  const confirmations = [...(script.confirmations ?? [])];
  const notes: string[] = [];

  return {
    ask: async (questions) => {
      const response = forms.shift();
      if (response === "aborted") {
        return Promise.resolve<WizardFormResult>("aborted");
      }

      const answers: Record<string, WizardAnswer> = {};
      for (const question of questions) {
        answers[question.id] = response?.[question.id] ?? defaultAnswer(question);
      }
      return Promise.resolve(Object.freeze(answers));
    },
    confirm: async () => Promise.resolve(confirmations.shift() ?? "accepted"),
    note: (text) => {
      notes.push(text);
      script.output?.write(`${safe(text)}\n`);
    },
    notes,
  };
}

/** The `--yes` implementation: default answers, accepted confirmations, notes to `output`. */
export function createDefaultsWizardIo(output: Writable): ScriptedWizardIo {
  return createScriptedWizardIo({ output });
}
