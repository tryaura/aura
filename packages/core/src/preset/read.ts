import type { AuraTeamPreset } from "@tryaura/aura-sdk";

import type { ScanDiagnostic } from "../workspace/diagnostics.js";
import type { FileReader } from "../workspace/reader.js";
import { MAX_TEAM_PRESET_BYTES } from "../workspace/reader-limits.js";
import { AURA_TEAM_PRESET_PATH, resolveTeamPresetPath } from "./protocol.js";
import { validateTeamPreset } from "./schema.js";

const PRESET_DIAGNOSTIC_ID = "core/team-preset";

/** The team preset in effect, alongside anything wrong with the file that carries it. */
export interface TeamPresetState {
  readonly diagnostics: readonly ScanDiagnostic[];
  /** Absent when no preset file exists — which is not a problem, just the default. */
  readonly preset: AuraTeamPreset | undefined;
  /** Invalid is distinct from missing because a broken allowlist must fail closed. */
  readonly status: "invalid" | "missing" | "ready";
}

/**
 * Reads and validates the workspace team preset.
 *
 * A missing file is the ordinary case and produces neither preset nor diagnostic. An unreadable or
 * invalid file produces a diagnostic and no preset: allowlist enforcement downstream treats "no
 * preset" as "everything permitted", so a broken preset must be surfaced rather than silently
 * widening what a team locked down.
 */
export async function readTeamPreset(cwd: string, reader: FileReader): Promise<TeamPresetState> {
  const path = resolveTeamPresetPath(cwd);
  const contents = await reader.read(path, { maxBytes: MAX_TEAM_PRESET_BYTES });

  if (!contents.exists) {
    return { diagnostics: [], preset: undefined, status: "missing" };
  }
  if (contents.problem !== undefined || contents.isDirectory || contents.content === undefined) {
    return failure(path, "cannot be read");
  }
  if ((contents.size ?? 0) > MAX_TEAM_PRESET_BYTES) {
    return failure(
      path,
      `is larger than the ${String(MAX_TEAM_PRESET_BYTES)} byte team preset limit`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.content);
  } catch {
    // The parse error is dropped, not forwarded: JSON.parse echoes the bytes it choked on.
    return failure(path, "is not valid JSON");
  }

  const result = validateTeamPreset(parsed);
  if (result.kind === "invalid") {
    return failure(path, `is not a valid team preset (${result.problem})`);
  }
  return { diagnostics: [], preset: result.preset, status: "ready" };
}

function failure(path: string, reason: string): TeamPresetState {
  return {
    diagnostics: [
      {
        adapterId: PRESET_DIAGNOSTIC_ID,
        message: `Team preset "${AURA_TEAM_PRESET_PATH}" ${reason}, so it is ignored.`,
        path,
        phase: "read",
      },
    ],
    preset: undefined,
    status: "invalid",
  };
}
