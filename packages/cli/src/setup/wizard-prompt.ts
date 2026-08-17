import { emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { safe } from "../safe-text.js";
import { displayWidth } from "../text-width.js";
import { createFormSession } from "./wizard-form.js";
import { claimTerminal, supportsRawMode } from "./wizard-terminal.js";
import {
  DEFAULT_WIZARD_VIEWPORT,
  renderAnsweredSummary,
  renderWizardFrame,
  type WizardViewport,
} from "./wizard-render.js";
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
    const viewport = resolveViewport(stdout);
    const frame = renderWizardFrame(session.frame(), options.colorDepth, viewport);
    stdout.write(`${erasure(erase)}${frame}`);
    lastFrame = frame;
    renderedLines = countLines(frame, viewport.columns);
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
        stdout.write(erasure(renderedLines));
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
        const viewport = resolveViewport(stdout);
        paint(Math.max(renderedLines, countLines(lastFrame, viewport.columns)));
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

function erasure(lines: number): string {
  return lines > 0 ? `\u001b[${String(lines)}A\r\u001b[0J` : "";
}
/**
 * Rows the terminal actually used, which is what `erasure` has to undo.
 *
 * A line wider than the terminal occupies more than one row, so counting newlines alone
 * under-reports the frame and the next repaint erases too little. `displayWidth` already counts
 * escape sequences as zero columns, so styled lines measure at their visible width. A line of
 * exactly `columns` still counts as one row: terminals defer the wrap until another character
 * arrives, and the newline arrives first.
 */
function countLines(frame: string, columns: number): number {
  let count = 0;
  for (const line of frame.split("\n").slice(0, -1)) {
    count += Math.max(1, Math.ceil(displayWidth(line) / columns));
  }
  return count;
}

function resolveViewport(stdout: Writable): WizardViewport {
  return {
    columns: terminalSize(stdout, "columns") ?? DEFAULT_WIZARD_VIEWPORT.columns,
    rows: terminalSize(stdout, "rows") ?? DEFAULT_WIZARD_VIEWPORT.rows,
  };
}

function terminalSize(stdout: Writable, field: "columns" | "rows"): number | undefined {
  if (field === "columns") {
    return positiveInteger("columns" in stdout ? stdout.columns : undefined);
  }
  return positiveInteger("rows" in stdout ? stdout.rows : undefined);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
