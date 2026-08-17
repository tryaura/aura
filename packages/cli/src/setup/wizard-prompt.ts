import { emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { safe } from "../safe-text.js";
import { createFormSession, type Keypress } from "./wizard-form.js";
import {
  DEFAULT_WIZARD_VIEWPORT,
  renderAnsweredSummary,
  renderWizardFrame,
  type WizardViewport,
} from "./wizard-render.js";
import type {
  WizardConfirmation,
  WizardFormResult,
  WizardIo,
  WizardQuestion,
} from "./wizard-types.js";

export interface InteractiveWizardOptions {
  readonly colorDepth: number;
  readonly stdin: Readable;
  readonly stdout: Writable;
}

const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";

/**
 * The terminal implementation of {@link WizardIo}.
 *
 * One tabbed form per `ask` call, driven by the state machine in `wizard-form.ts`. Frames repaint
 * in place against the injected streams — nothing here reaches for `process.stdout`, so the engine
 * behaves identically under a captured stream.
 */
export function createInteractiveWizardIo(options: InteractiveWizardOptions): WizardIo {
  return {
    ask: async (questions) => runForm(questions, options),
    confirm: async (prompt) => runConfirm(prompt, options),
    note: (text) => {
      options.stdout.write(`${safe(text)}\n`);
    },
  };
}

async function runConfirm(
  prompt: string,
  options: InteractiveWizardOptions,
): Promise<WizardConfirmation> {
  const result = await runForm(
    [
      {
        id: "confirm",
        kind: "select",
        label: "Apply",
        options: [
          { label: "Apply", value: "apply" },
          { description: "Nothing has been written yet.", label: "Cancel", value: "cancel" },
        ],
        prompt,
      },
    ],
    options,
  );

  if (result === "aborted") {
    return "aborted";
  }
  const answer = result["confirm"];
  return answer?.kind === "options" && answer.values.includes("apply") ? "accepted" : "declined";
}

async function runForm(
  questions: readonly WizardQuestion[],
  options: InteractiveWizardOptions,
): Promise<WizardFormResult> {
  const { stdin, stdout } = options;
  const session = createFormSession(questions);
  let renderedLines = 0;

  const paint = (): void => {
    // Read the size every repaint rather than once, so a resize mid-form is picked up.
    const viewport = resolveViewport(stdout);
    const frame = renderWizardFrame(session.frame(), options.colorDepth, viewport);
    stdout.write(`${erasure(renderedLines)}${frame}`);
    renderedLines = countLines(frame, viewport.columns);
  };

  return new Promise<WizardFormResult>((resolveForm) => {
    const raw = supportsRawMode(stdin);
    if (raw) {
      stdin.setRawMode(true);
      stdout.write(HIDE_CURSOR);
    }
    emitKeypressEvents(stdin);
    stdin.resume();

    const finish = (result: WizardFormResult): void => {
      stdin.off("keypress", onKeypress);
      stdin.off("end", onEnd);
      stdin.pause();
      if (raw) {
        stdin.setRawMode(false);
        stdout.write(SHOW_CURSOR);
      }
      stdout.write(erasure(renderedLines));
      if (result !== "aborted") {
        stdout.write(renderAnsweredSummary(session.views()));
      }
      resolveForm(result);
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
    paint();
  });
}

function toKeypress(sequence: unknown, key: unknown): Keypress {
  const fallback = typeof sequence === "string" ? sequence : undefined;
  if (typeof key !== "object" || key === null) {
    return { ctrl: false, meta: false, name: undefined, sequence: fallback };
  }
  return {
    ctrl: "ctrl" in key && key.ctrl === true,
    meta: "meta" in key && key.meta === true,
    name: keyText(key, "name"),
    sequence: keyText(key, "sequence") ?? fallback,
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

const ESCAPE = "\u001b";

/**
 * Rows the terminal actually used, which is what `erasure` has to undo.
 *
 * A line wider than the terminal occupies more than one row, so counting newlines alone
 * under-reports the frame and the next repaint erases too little. Styling is skipped because
 * escape sequences take no width. A line of exactly `columns` still counts as one row: terminals
 * defer the wrap until another character arrives, and the newline arrives first.
 */
function countLines(frame: string, columns: number): number {
  let count = 0;
  for (const line of frame.split("\n").slice(0, -1)) {
    count += Math.max(1, Math.ceil(visibleWidth(line) / columns));
  }
  return count;
}

function visibleWidth(line: string): number {
  let width = 0;
  let inSequence = false;

  for (const character of line) {
    if (inSequence) {
      inSequence = !endsEscapeSequence(character);
    } else if (character === ESCAPE) {
      inSequence = true;
    } else {
      width += 1;
    }
  }
  return width;
}

/** A CSI sequence runs until its final byte, which is the first ASCII letter after the escape. */
function endsEscapeSequence(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
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

function supportsRawMode(
  stdin: Readable,
): stdin is Readable & { isTTY: boolean; setRawMode: (mode: boolean) => unknown } {
  return (
    "isTTY" in stdin &&
    stdin.isTTY === true &&
    "setRawMode" in stdin &&
    typeof stdin.setRawMode === "function"
  );
}
