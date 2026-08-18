/**
 * Test-only seams into core's scan state.
 *
 * Kept out of the main entry point on purpose. A convergence planner holds the configuration bytes
 * a scan read, and the only reason to install one by hand is to drive a check's fixtures without
 * building a filesystem; a shipped command has no business doing it.
 */

export { rememberMcpConvergence } from "./workspace/mcp-plan.js";
export type { AppMcpConvergence, AppMcpConvergenceResult } from "./workspace/mcp-convergence.js";
