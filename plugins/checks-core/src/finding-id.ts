import { sha256 } from "./hashing.js";

/** Stable, compact identity derived only from what a finding is structurally about. */
export function structuralFindingId(kind: string, parts: readonly string[]): string {
  return `${kind}:${sha256(parts.join("\u0000")).slice(0, 16)}`;
}
