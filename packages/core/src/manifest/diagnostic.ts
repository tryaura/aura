import type { AuraManifestState } from "@tryaura/aura-sdk";

import type { ScanDiagnostic } from "../workspace/diagnostics.js";

/** Turns a read-only manifest state into the core-owned scan error shown by every check run. */
export function auraManifestDiagnostics(state: AuraManifestState): readonly ScanDiagnostic[] {
  if (state.status !== "read-only") {
    return [];
  }
  return [
    {
      adapterId: "core/manifest",
      message: state.problem.message,
      path: state.path,
      phase: state.problem.kind === "file" ? "read" : "parse",
    },
  ];
}
