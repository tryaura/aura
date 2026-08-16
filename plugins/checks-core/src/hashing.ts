import { createHash } from "node:crypto";

/** Stable digest for finding identities and content grouping. Not used for any security decision. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
