import type { WriteFileOperation } from "@tryaura/aura-sdk";

import { FILE_MODES, MAX_MUTABLE_FILE_BYTES } from "./limits.js";

/** Why a write is refused before its target is read, or undefined when nothing rules it out. */
export function writeRejection(operation: WriteFileOperation, content: Buffer): string | undefined {
  if (content.byteLength > MAX_MUTABLE_FILE_BYTES) {
    return `content is ${content.byteLength} bytes, above the ${MAX_MUTABLE_FILE_BYTES} byte limit for one operation`;
  }
  // `FileMode` closes this set at compile time, but plugins ship compiled, and the value reaches
  // `chmod` unchanged. Checking it is what keeps a plan from asking for setuid or world-writable.
  if (operation.mode !== undefined && !FILE_MODES.has(operation.mode)) {
    return `mode 0o${operation.mode.toString(8)} is not a permitted file mode`;
  }

  return undefined;
}
