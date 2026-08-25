import type { EligibilityRefusal } from "./eligibility.js";
import type { InstallOutcome } from "./install.js";
import type { UpdateResolution } from "./provider.js";

type UpdateResolutionFailure = Extract<UpdateResolution, { readonly kind: "failure" }>["reason"];

/** What an update check did, returned so an explicit command can report its own verdict. */
export type StartupUpdateOutcome =
  | { readonly kind: "busy" }
  | { readonly kind: "current" }
  | {
      readonly kind: "failed";
      readonly reason: UpdateResolutionFailure | "install" | "unexpected" | "untrusted-download";
    }
  | { readonly kind: "installed"; readonly version: string }
  | { readonly kind: "skipped"; readonly reason: EligibilityRefusal | "cached" };

export function appliedUpdateOutcome(
  version: string,
  outcome: InstallOutcome,
): StartupUpdateOutcome {
  if (outcome.kind === "installed") {
    return { kind: "installed", version };
  }
  if (outcome.kind === "skipped") {
    return outcome.reason === "already-current" ? { kind: "current" } : { kind: "busy" };
  }
  return {
    kind: "failed",
    reason: outcome.kind === "refused" ? "untrusted-download" : "install",
  };
}

export function traceInstallOutcome(outcome: InstallOutcome): string {
  if (outcome.kind === "failed") {
    return `failed: ${outcome.reason}`;
  }
  return outcome.kind === "skipped" ? `skipped: ${outcome.reason}` : outcome.kind;
}
