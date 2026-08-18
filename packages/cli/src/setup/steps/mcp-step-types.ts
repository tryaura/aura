import type { AuraManifestMcpServer } from "@tryaura/aura-sdk";

import type { McpSetupCatalogEntry } from "../mcp-catalog.js";
import { SETUP_ABORTED, SETUP_BACK } from "../types.js";

export interface WorkingMcpEntry extends McpSetupCatalogEntry {
  readonly customTransportIsFresh?: boolean | undefined;
  readonly selectedServer?: AuraManifestMcpServer | undefined;
}

export type McpStepControl = typeof SETUP_ABORTED | typeof SETUP_BACK;
