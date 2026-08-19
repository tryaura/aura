import type { FindingLocation } from "@tryaura/aura-sdk";
import { displayPath } from "@tryaura/core/display-path";

import type { HumanCheckRenderOptions } from "./render-human-types.js";
import { safe } from "./safe-text.js";

export function locationText(location: FindingLocation, options: HumanCheckRenderOptions): string {
  const path = displayPath(location.path, options.roots);
  const line = location.line === undefined ? "" : `:${String(location.line)}`;
  const column = line === "" || location.column === undefined ? "" : `:${String(location.column)}`;
  return `${safe(path)}${line}${column}`;
}
