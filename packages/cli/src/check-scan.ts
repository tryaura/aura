import type { Writable } from "node:stream";

import type { Adapter, Environment } from "@tryaura/aura-sdk";
import {
  buildWorkspaceModel,
  createMcpUrlRequester,
  type PluginRegistry,
  type WorkspaceScan,
} from "@tryaura/core";

import { startScanProgress, type ScanProgressRow } from "./scan-progress.js";

export interface CheckScanOptions {
  readonly adapters: readonly Adapter[];
  readonly colorDepth: number;
  /** Boot environment variables, read only to configure the remote MCP requester. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly environment: Environment;
  /** A machine-readable run paints no progress: its stream carries one document, not a display. */
  readonly json: boolean;
  readonly online: boolean;
  readonly registry: PluginRegistry;
  readonly stdout: Writable;
}

/** The scan a check run performs, repeatable so a fix pass can ask the machine again. */
export interface CheckScan {
  /** Releases pooled sockets so they do not keep the process alive. Call once, at the end. */
  readonly close: () => Promise<void>;
  /** One complete scan, with its progress frame painted and erased around it. */
  readonly run: () => Promise<WorkspaceScan>;
}

/**
 * Binds one check run's scan settings to the surface that reports its progress.
 *
 * A check scans twice when it fixes something — once to find the findings, once to say which
 * survived — and both scans must be the same scan, against the same probe settings and the same
 * remote requester. Holding them here is what makes that true by construction, and gives the
 * progress frame somewhere to live that is not the command's already-long `execute`.
 */
export function createCheckScan(options: CheckScanOptions): CheckScan {
  const requester = options.online ? createMcpUrlRequester(options.env) : undefined;
  const scanOptions = {
    adapters: options.adapters,
    environment: options.environment,
    mcpCatalog: options.registry.mcpServers,
    mcpProbes: requester === undefined ? {} : { urlRequest: requester.request },
    skills: options.registry.skills,
  };
  // Synthetic adapters model files, not installed applications; naming one here would claim the
  // user runs something they have never heard of. They probe nothing, so nothing waits on them.
  const rows: readonly ScanProgressRow[] = options.json
    ? []
    : options.adapters
        .filter((adapter) => adapter.synthetic !== true)
        .map((adapter) => ({ id: adapter.id, label: adapter.displayName }));

  return {
    close: async () => {
      await requester?.close();
    },
    run: async () => {
      const progress = startScanProgress({
        colorDepth: options.colorDepth,
        rows,
        stdout: options.stdout,
      });
      try {
        return await buildWorkspaceModel({ ...scanOptions, onAdapterScan: progress.report });
      } finally {
        progress.close();
      }
    },
  };
}
