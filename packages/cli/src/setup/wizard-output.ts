import type { Writable } from "node:stream";

import { terminalDimension } from "../terminal-frame.js";
import { DEFAULT_WIZARD_VIEWPORT, type WizardViewport } from "./wizard-render.js";

export function resolveWizardViewport(stdout: Writable): WizardViewport {
  return {
    columns: terminalDimension(stdout, "columns") ?? DEFAULT_WIZARD_VIEWPORT.columns,
    rows: terminalDimension(stdout, "rows") ?? DEFAULT_WIZARD_VIEWPORT.rows,
  };
}
