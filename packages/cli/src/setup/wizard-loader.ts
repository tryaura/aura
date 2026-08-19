import type { InteractiveWizardOptions } from "./wizard-prompt.js";
import { renderWizardLoadingFrame, type WizardLoadingItemView } from "./wizard-loading-render.js";
import { countWizardFrameRows, eraseWizardFrame, resolveWizardViewport } from "./wizard-output.js";
import { claimTerminal, supportsRawMode } from "./wizard-terminal.js";
import type { WizardFlowContext, WizardLoadRequest, WizardLoadUpdate } from "./wizard-types.js";

/** Spinner cadence; fast enough to read as motion, slow enough not to churn the terminal. */
const SPINNER_INTERVAL_MS = 80;

/**
 * Runs asynchronous work while maintaining one animated, itemized wizard frame.
 *
 * The loader takes the same terminal claim a form does, for the same two reasons. A visible cursor
 * blinks inside a frame that is repainting ten times a second, and cooked-mode echo prints every
 * key struck during the wait into the middle of it. Worse, those keys survive: stdin is only
 * paused between forms, so a wait long enough to type through would deliver the type-ahead to the
 * next form as real keypresses and silently move its selection. Raw mode with a discarding reader
 * means keys pressed at a loading frame land nowhere, which is what a loading frame promises.
 */
export async function runWizardLoader<T>(
  request: WizardLoadRequest,
  task: (update: WizardLoadUpdate) => Promise<T>,
  options: InteractiveWizardOptions,
  flow?: WizardFlowContext,
): Promise<T> {
  if (request.items.length === 0) {
    return task(() => undefined);
  }
  const { stdin, stdout } = options;
  const statuses = new Map<string, WizardLoadingItemView["status"]>(
    request.items.map((item) => [item.id, "pending"]),
  );
  let renderedLines = 0;
  let spinnerFrame = 0;
  const paint = (): void => {
    const viewport = resolveWizardViewport(stdout);
    const items: WizardLoadingItemView[] = request.items.map((item) => ({
      ...item,
      status: statuses.get(item.id) ?? "pending",
    }));
    const frame = renderWizardLoadingFrame(
      request.prompt,
      items,
      spinnerFrame,
      options.colorDepth,
      viewport,
      flow,
    );
    stdout.write(`${eraseWizardFrame(renderedLines)}${frame}`);
    renderedLines = countWizardFrameRows(frame, viewport.columns);
  };
  const update: WizardLoadUpdate = (id, status) => {
    if (statuses.has(id)) {
      statuses.set(id, status);
      paint();
    }
  };

  const claim = supportsRawMode(stdin) ? claimTerminal(stdin, stdout) : undefined;
  const discard = (): void => {};
  stdin.on("data", discard);
  stdin.resume();

  paint();
  const animation = setInterval(() => {
    spinnerFrame += 1;
    paint();
  }, SPINNER_INTERVAL_MS);
  try {
    return await task(update);
  } finally {
    clearInterval(animation);
    stdin.off("data", discard);
    stdin.pause();
    stdout.write(eraseWizardFrame(renderedLines));
    claim?.release();
  }
}
