import type { Keypress } from "./wizard-types.js";
import { wrapPreviewLines, type WizardPreview } from "./wizard-render.js";

/**
 * An open preview, plus how far it can scroll.
 *
 * The bound is measured against the narrowest terminal worth rendering into, so it always covers
 * the real one: the renderer knows the true viewport and clips the offset again on the way out.
 * This side only keeps the offset from running away while the reader holds ↓ down.
 */
export interface PreviewState extends WizardPreview {
  readonly maxOffset: number;
}

/** What one key did to the preview, and the preview it left behind. */
export interface PreviewKeypressResult {
  readonly event: "abort" | "none" | "repaint";
  readonly preview: PreviewState | undefined;
}

const PREVIEW_SCROLL_COLUMNS = 40;
const PREVIEW_PAGE_ROWS = 10;

export function openPreview(content: string, title: string): PreviewState {
  return {
    content,
    maxOffset: Math.max(0, wrapPreviewLines(content, PREVIEW_SCROLL_COLUMNS).length - 1),
    offset: 0,
    title,
  };
}

/**
 * Runs the preview overlay, or declines the key so the form beneath it handles it.
 *
 * Returns `undefined` only when no preview is open and the key is not the universal abort, which
 * is what tells the caller to fall through to ordinary navigation.
 */
export function handlePreviewKeypress(
  preview: PreviewState | undefined,
  keypress: Keypress,
): PreviewKeypressResult | undefined {
  if (keypress.ctrl && keypress.name === "c") {
    return { event: "abort", preview };
  }
  if (preview === undefined) {
    return undefined;
  }
  if (closesPreview(keypress)) {
    return { event: "repaint", preview: undefined };
  }
  const scrolled = scrollPreview(preview, keypress);
  return scrolled === undefined
    ? { event: "none", preview }
    : { event: "repaint", preview: scrolled };
}

function closesPreview(keypress: Keypress): boolean {
  return (
    keypress.name === "escape" ||
    keypress.name === "return" ||
    keypress.name === "enter" ||
    keypress.sequence === "p"
  );
}

function scrollPreview(preview: PreviewState, keypress: Keypress): PreviewState | undefined {
  const delta = scrollDelta(keypress);
  if (delta === 0) {
    return undefined;
  }
  const offset = Math.min(Math.max(preview.offset + delta, 0), preview.maxOffset);
  return offset === preview.offset ? undefined : { ...preview, offset };
}

function scrollDelta(keypress: Keypress): number {
  switch (keypress.name) {
    case "up": {
      return -1;
    }
    case "down": {
      return 1;
    }
    case "pageup": {
      return -PREVIEW_PAGE_ROWS;
    }
    case "pagedown": {
      return PREVIEW_PAGE_ROWS;
    }
    default: {
      return 0;
    }
  }
}
