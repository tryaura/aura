import type { FindingLocation } from "@tryaura/aura-sdk";
import { displayPath } from "@tryaura/core/display-path";

import type { HumanCheckRenderOptions } from "./render-human-types.js";
import { safeFindingText } from "./safe-text.js";

/**
 * One location line, bounded the same way a finding's message is.
 *
 * The path came out of third-party configuration, so it carries a hostile plugin's line length as
 * well as its characters: the report's location ceiling caps how many of these print, and this
 * caps how far any one of them can run.
 */
export function locationText(location: FindingLocation, options: HumanCheckRenderOptions): string {
  const path = displayPath(location.path, options.roots);
  const line = location.line === undefined ? "" : `:${String(location.line)}`;
  const column = line === "" || location.column === undefined ? "" : `:${String(location.column)}`;
  return `${safeFindingText(path)}${line}${column}`;
}
