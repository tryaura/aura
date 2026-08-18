import { createHash } from "node:crypto";

import type { WriteFileOperation } from "@tryaura/aura-sdk";

import { FILE_MODES, MAX_MUTABLE_FILE_BYTES } from "./limits.js";
import { isCapturedFile, type CapturedFileState, type PathState } from "./state.js";

/** What a write says about the state its contents were derived from, when it says anything. */
const STALE = "the file changed after Aura read it; re-run the command to plan against it";

/**
 * Checks what a write claimed the file looked like when its contents were built.
 *
 * A plan is built from a scan and applied afterwards. For a write that rewrote the file's own
 * previous bytes rather than generating them, an edit in that gap is not a stale preview — it is
 * work the write would silently revert. Reported as a conflict so the plan stops and the user
 * re-runs against current state.
 */
export function unmetPrecondition(
  writes: readonly WriteFileOperation[],
  before: PathState,
): string | undefined {
  for (const write of writes) {
    const precondition = write.precondition;
    if (precondition === undefined) {
      continue;
    }
    const satisfied =
      precondition.kind === "absent"
        ? before.kind === "missing"
        : isCapturedFile(before) && digest(before) === precondition.digest;
    if (!satisfied) {
      return STALE;
    }
  }
  return undefined;
}

function digest(before: CapturedFileState): string {
  return createHash("sha256").update(before.content).digest("hex");
}

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
