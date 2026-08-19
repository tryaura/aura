import { safe } from "../safe-text.js";
import type { Style } from "../style.js";
import { clipBody } from "./wizard-clip.js";
import {
  createWizardStyle,
  DEFAULT_WIZARD_VIEWPORT,
  type WizardFrame,
  type WizardViewport,
} from "./wizard-render.js";
import { DONE, renderTabBar, UNANSWERED } from "./wizard-tabs.js";
import type {
  WizardFlowContext,
  WizardLoadItem,
  WizardLoadStatus,
  WizardQuestion,
} from "./wizard-types.js";

export interface WizardLoadingItemView extends WizardLoadItem {
  readonly status: "pending" | WizardLoadStatus;
}

const FRAME_BASE_CHROME_ROWS = 4;
const SPINNER = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);

/** Renders an asynchronous phase under the same flow header as the form it is preparing. */
export function renderWizardLoadingFrame(
  prompt: string,
  items: readonly WizardLoadingItemView[],
  spinnerFrame: number,
  colorDepth: number,
  viewport: WizardViewport = DEFAULT_WIZARD_VIEWPORT,
  flow?: WizardFlowContext,
): string {
  const style = createWizardStyle(colorDepth);
  const loadingQuestion: WizardQuestion = {
    id: "loading",
    kind: "select",
    label: flow?.step?.label ?? "Loading",
    options: [],
    prompt,
  };
  const frame: WizardFrame = {
    activeTab: 0,
    cursorRow: 0,
    ...(flow === undefined ? {} : { flow }),
    questions: [
      {
        answered: false,
        question: loadingQuestion,
        selected: new Set(),
        text: "",
      },
    ],
  };
  const barLines = renderTabBar(frame, true, style, viewport.columns);
  const body = [` ${style.bold(safe(prompt))}`, ""];
  let focus = body.length;
  items.forEach((item, index) => {
    if (item.status === "active") {
      focus = body.length;
    }
    body.push(`   ${loadingGlyph(item.status, spinnerFrame, style)} ${safe(item.label)}`);
    if (index === 0 && items.every((candidate) => candidate.status === "pending")) {
      focus = body.length - 1;
    }
  });
  const lines = [
    ...barLines,
    "",
    ...clipBody(
      body,
      focus,
      viewport.rows - FRAME_BASE_CHROME_ROWS - barLines.length,
      style,
      viewport.columns,
    ),
    "",
    style.dim(" Loading, please wait…"),
  ];
  return `${lines.join("\n")}\n`;
}

function loadingGlyph(
  status: WizardLoadingItemView["status"],
  frame: number,
  style: Style,
): string {
  if (status === "complete") {
    return DONE;
  }
  if (status === "pending") {
    return style.dim(UNANSWERED);
  }
  return SPINNER[frame % SPINNER.length] ?? SPINNER[0] ?? "…";
}
