import type { FixPlan, McpConvergenceBlocker, WriteFileOperation } from "@tryaura/aura-sdk";

/** Result of building one application's complete manifest-driven MCP remediation. */
export interface ManifestMcpConvergence {
  readonly blockers: readonly McpConvergenceBlocker[];
  readonly plan?: FixPlan | undefined;
}

/** One application's configuration-only convergence against an explicit desired manifest. */
export interface DesiredMcpConvergence {
  readonly blockers: readonly McpConvergenceBlocker[];
  readonly operations: readonly WriteFileOperation[];
  readonly ownedNames: readonly string[];
}

/** Ledger-checked result of asking Aura to stop managing one configured MCP server. */
export interface McpServerRemovalPlan extends ManifestMcpConvergence {
  /** True only when the ownership ledger authorizes Aura to remove this name. */
  readonly owned: boolean;
}
