/** The kind of non-invasive probe Aura performed for one MCP server. */
export type McpProbeKind = "command" | "package" | "url";

/**
 * The outcome vocabulary shared by every MCP probe.
 *
 * Only `error` means a probe ran and established a problem. The remaining non-success states keep
 * missing prerequisites and deliberately unsupported checks from turning into speculative
 * findings.
 */
export type McpProbeStatus = "ok" | "error" | "unsupported" | "unavailable" | "unknown";

/** One credential-safe observation made about a configured MCP server. */
export interface McpProbeResult {
  /** Bounded explanation that never contains request headers or credential values. */
  readonly detail?: string | undefined;
  readonly kind: McpProbeKind;
  readonly status: McpProbeStatus;
}
