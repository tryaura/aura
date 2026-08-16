import { type AppModel } from "@tryaura/aura-sdk";

/**
 * The names this adapter puts into the workspace model, published for checks to read.
 *
 * A check that reached for these as string literals would keep compiling after a rename here and
 * silently stop finding anything, so the contract is exported and imported rather than retyped.
 */
export const CODEX_SOURCE_IDS = Object.freeze({
  instructions: "codex.instructions.global",
  mcp: "codex.mcp.global",
});

export const CODEX_ADAPTER_ID = "codex";

/** Metadata key holding a {@link ProjectTrust}. */
export const CODEX_PROJECT_TRUST_KEY = "projectTrust";

/** Whether Codex will apply project-scoped configuration for the current project. */
export type ProjectTrust = "trusted" | "unknown" | "untrusted";

/** Reads this adapter's trust marker back out of an {@link AppModel}. */
export function readCodexProjectTrust(app: AppModel): ProjectTrust | undefined {
  const trust = app.metadata?.[CODEX_PROJECT_TRUST_KEY];
  return trust === "trusted" || trust === "untrusted" || trust === "unknown" ? trust : undefined;
}
