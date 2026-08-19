import { emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { safe } from "../safe-text.js";
import { createFormSession } from "./wizard-form.js";
import { runWizardLoader } from "./wizard-loader.js";
import { countWizardFrameRows, eraseWizardFrame, resolveWizardViewport } from "./wizard-output.js";
import { claimTerminal, supportsRawMode } from "./wizard-terminal.js";
import { renderAnsweredSummary, renderWizardFrame } from "./wizard-render.js";
import type {
  Keypress,
  WizardConfirmation,
  WizardFlowContext,
  WizardFormResult,
  WizardIo,
  WizardQuestion,
} from "./wizard-types.js";

export interface InteractiveWizardOptions {
  readonly colorDepth: number;
  readonly stdin: Readable;
  readonly stdout: Writable;
}

/**
 * The terminal implementation of {@link WizardIo}.
 *
 * One tabbed form per `ask` call, driven by the state machine in `wizard-form.ts`. Frames repaint
 * in place against the injected streams — nothing here reaches for `process.stdout`, so the engine
 * behaves identically under a captured stream.
 */
export function createInteractiveWizardIo(options: InteractiveWizardOptions): WizardIo {
  // Back navigation re-runs forms; a form's collapsed summary prints on its first completion and
  // again only when a re-answer changed it — repeating an unchanged answer must not stack another
  // copy of the same line, and a changed answer must not leave the stale line as the last word.
  const summarized = new Map<string, string>();
  const summarizeOnce: SummaryGate = (questions, summary) => {
    const key = questions.map((question) => question.id).join(" ");
    if (summarized.get(key) === summary) {
      return false;
    }
    summarized.set(key, summary);
    return true;
  };

  return {
    ask: async (questions, flow) => runForm(questions, options, flow, summarizeOnce),
    confirm: async (prompt, flow) => runConfirm(prompt, options, flow, summarizeOnce),
    load: async (request, task, flow) => runWizardLoader(request, task, options, flow),
    note: (text) => {
      options.stdout.write(`${safe(text)}\n`);
    },
  };
}

/** Decides at completion time whether a form's collapsed summary should print. */
type SummaryGate = (questions: readonly WizardQuestion[], summary: string) => boolean;

async function runConfirm(
  prompt: string,
  options: InteractiveWizardOptions,
  flow?: WizardFlowContext,
  summarize?: SummaryGate,
): Promise<WizardConfirmation> {
  const result = await runForm(
    [
      {
        id: "confirm",
        kind: "select",
        // As the flow's final action this question IS the Submit tab; standalone confirms keep
        // their own name.
        label: flow?.submit === true ? "Submit" : "Apply",
        options: [
          { label: "Apply", value: "apply" },
          { description: "Nothing has been written yet.", label: "Cancel", value: "cancel" },
        ],
        prompt,
      },
    ],
    options,
    flow,
    summarize,
  );

  if (result === "aborted" || result === "back") {
    return result;
  }
  const answer = result["confirm"];
  return answer?.kind === "options" && answer.values.includes("apply") ? "accepted" : "declined";
}

async function runForm(
  questions: readonly WizardQuestion[],
  options: InteractiveWizardOptions,
  flow?: WizardFlowContext,
  summarize?: SummaryGate,
): Promise<WizardFormResult> {
  const { stdin, stdout } = options;
  const session = createFormSession(questions, flow);
  let renderedLines = 0;
  let lastFrame = "";

  const paint = (erase: number = renderedLines): void => {
    // Read the size every repaint rather than once, so a resize mid-form is picked up.
    const viewport = resolveWizardViewport(stdout);
    const frame = renderWizardFrame(session.frame(), options.colorDepth, viewport);
    stdout.write(`${eraseWizardFrame(erase)}${frame}`);
    lastFrame = frame;
    renderedLines = countWizardFrameRows(frame, viewport.columns);
  };

  // The terminal must come back on every way out of the form — resolution, a thrown repaint, or
  // the process being killed mid-form. The `finally` covers the first two; `claimTerminal` owns
  // the rest, and a run with no TTY takes no claim at all.
  const claim = supportsRawMode(stdin) ? claimTerminal(stdin, stdout) : undefined;

  try {
    emitKeypressEvents(stdin);
    stdin.resume();

    return await new Promise<WizardFormResult>((resolveForm) => {
      const finish = (result: WizardFormResult): void => {
        stdin.off("keypress", onKeypress);
        stdin.off("end", onEnd);
        stdout.off("resize", onResize);
        stdin.pause();
        stdout.write(eraseWizardFrame(renderedLines));
        // Only a completed form leaves its collapsed summary behind, and only when the summary
        // gate lets it through; a backed-out or aborted form vanishes without a trace.
        if (result !== "aborted" && result !== "back") {
          const summary = renderAnsweredSummary(session.views());
          if (summarize?.(questions, summary) ?? true) {
            stdout.write(summary);
          }
        }
        resolveForm(result);
      };

      // A resize rewraps what is on screen, so the frame is repainted against the new viewport
      // immediately instead of waiting for the next keypress to notice. A shrink rewraps the old
      // frame taller than the rows counted at the old width, so the erasure takes the larger of
      // the two counts — recounting the painted frame against the new width — rather than
      // trusting the stale one and leaving artifact rows behind.
      const onResize = (): void => {
        const viewport = resolveWizardViewport(stdout);
        paint(Math.max(renderedLines, countWizardFrameRows(lastFrame, viewport.columns)));
      };

      const onEnd = (): void => {
        finish("aborted");
      };

      const onKeypress = (sequence: unknown, key: unknown): void => {
        switch (session.handle(toKeypress(sequence, key))) {
          case "abort": {
            finish("aborted");
            return;
          }
          case "back": {
            finish("back");
            return;
          }
          case "none": {
            return;
          }
          case "repaint": {
            paint();
            return;
          }
          case "submit": {
            finish(session.answers());
            return;
          }
        }
      };

      stdin.on("keypress", onKeypress);
      stdin.once("end", onEnd);
      stdout.on("resize", onResize);
      paint();
    });
  } finally {
    claim?.release();
  }
}

function toKeypress(sequence: unknown, key: unknown): Keypress {
  const fallback = typeof sequence === "string" ? sequence : undefined;
  if (typeof key !== "object" || key === null) {
    return { ctrl: false, meta: false, name: undefined, sequence: fallback, shift: false };
  }
  return {
    ctrl: "ctrl" in key && key.ctrl === true,
    meta: "meta" in key && key.meta === true,
    name: keyText(key, "name"),
    sequence: keyText(key, "sequence") ?? fallback,
    shift: "shift" in key && key.shift === true,
  };
}

function keyText(key: object, field: "name" | "sequence"): string | undefined {
  if (field === "name") {
    return "name" in key && typeof key.name === "string" ? key.name : undefined;
  }
  return "sequence" in key && typeof key.sequence === "string" ? key.sequence : undefined;
}
