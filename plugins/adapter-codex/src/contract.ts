import { type AppModel } from "@tryaura/aura-sdk";

/**
 * The names this adapter puts into the workspace model, published for checks to read.
 *
 * A check that reached for these as string literals would keep compiling after a rename here and
 * silently stop finding anything, so the contract is exported and imported rather than retyped.
 */
export const CODEX_SOURCE_IDS = Object.freeze({
  instructions: "codex.instructions.global",
  instructionsProject: "codex.instructions.project",
  mcp: "codex.mcp.global",
  skillsGlobal: "codex.skills.global",
});

/**
 * Suffix marking the higher-priority `AGENTS.override.md` beside a plain `AGENTS.md` slot.
 *
 * Codex reads the override at every scope and falls back to `AGENTS.md` only when it finds none, so
 * the two files are one slot with two candidates rather than two independent instruction sources.
 */
export const CODEX_OVERRIDE_SUFFIX = ".override";

/**
 * Names the slot for an `AGENTS.md` in a directory `ancestors` levels above the invocation
 * directory. Zero — the invocation directory itself — keeps the unsuffixed id.
 */
export function codexProjectInstructionsId(ancestors: number): string {
  return ancestors === 0
    ? CODEX_SOURCE_IDS.instructionsProject
    : `${CODEX_SOURCE_IDS.instructionsProject}.${String(ancestors)}`;
}

export const CODEX_ADAPTER_ID = "codex";

/** Metadata key holding a {@link ProjectTrust}. */
export const CODEX_PROJECT_TRUST_KEY = "projectTrust";

/**
 * Whether Codex will apply project-scoped configuration for the current project.
 *
 * `"unreadable"` is kept apart from `"unknown"`: a file Codex cannot parse says nothing about
 * trust, and the adapter already reports the unparseable file itself. A check that folded the two
 * together would announce an untrusted project as a second, unrelated-looking symptom of the one
 * broken file.
 */
export type ProjectTrust = "trusted" | "unknown" | "unreadable" | "untrusted";

const PROJECT_TRUST_VALUES: readonly ProjectTrust[] = Object.freeze([
  "trusted",
  "unknown",
  "unreadable",
  "untrusted",
]);

/** Reads this adapter's trust marker back out of an {@link AppModel}. */
export function readCodexProjectTrust(app: AppModel): ProjectTrust | undefined {
  const trust = app.metadata?.[CODEX_PROJECT_TRUST_KEY];
  return PROJECT_TRUST_VALUES.find((value) => value === trust);
}
