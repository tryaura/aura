import {
  AURA_MANAGED_BLOCK_BEGIN,
  AURA_MANAGED_BLOCK_END,
  AURA_MANAGED_SNIPPET_BEGIN_PREFIX,
  AURA_MANAGED_SNIPPET_END_PREFIX,
} from "./protocol.js";

export type Marker =
  | { readonly kind: "block-begin" }
  | { readonly kind: "block-end" }
  | { readonly hash: string; readonly id: string; readonly kind: "snippet-begin" }
  | { readonly id: string; readonly kind: "snippet-end" }
  | { readonly kind: "malformed" };

/** Parses exact protocol lines; callers suppress this inside Markdown fences. */
export function parseMarker(line: string): Marker | undefined {
  if (line === AURA_MANAGED_BLOCK_BEGIN) {
    return { kind: "block-begin" };
  }
  if (line === AURA_MANAGED_BLOCK_END) {
    return { kind: "block-end" };
  }
  if (line.startsWith(AURA_MANAGED_SNIPPET_BEGIN_PREFIX)) {
    const match = /^<!-- aura:begin id=(\S+) sha256=(\S+) -->$/.exec(line);
    return match === null || match[1] === undefined || match[2] === undefined
      ? { kind: "malformed" }
      : { hash: match[2], id: match[1], kind: "snippet-begin" };
  }
  if (line.startsWith(AURA_MANAGED_SNIPPET_END_PREFIX)) {
    const match = /^<!-- aura:end id=(\S+) -->$/.exec(line);
    return match === null || match[1] === undefined
      ? { kind: "malformed" }
      : { id: match[1], kind: "snippet-end" };
  }
  if (line.startsWith("<!-- aura:begin") || line.startsWith("<!-- aura:end")) {
    return { kind: "malformed" };
  }
  return undefined;
}
