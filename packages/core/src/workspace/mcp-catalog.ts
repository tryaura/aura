import { fileURLToPath } from "node:url";

import type { McpServerDef, McpServerManifest, ResolvedMcpServerDef } from "@tryaura/aura-sdk";
import { parseMcpServerManifest } from "@tryaura/aura-sdk";

import type { ScanDiagnostic } from "./diagnostics.js";
import { isEmbeddedAssetPath } from "./embedded-assets.js";
import type { FileReader, PathContents } from "./reader.js";
import { MAX_MCP_CATALOG_BYTES } from "./reader-limits.js";
import {
  failedResolution,
  partitionResolutions,
  type Resolution,
  type ResolutionOutcome,
} from "./resolution.js";

/** The core-owned adapter id standing in for catalog resolution, which no adapter performs. */
const MCP_DIAGNOSTIC_ID = "core/mcp-catalog";

/** One resolved catalog entry, or the reason it could not be resolved. */
type McpServerOutcome = ResolutionOutcome<ResolvedMcpServerDef>;

/**
 * Loads every registered MCP catalog definition, reporting each one it had to drop.
 *
 * Deliberately part of the scan rather than of registry construction. The registry is assembled
 * before any command runs — including `--help` — so resolving there would make one unreadable JSON
 * file the reason Aura cannot start, and would put a synchronous read on the path of every
 * invocation whether or not it touches MCP. Here an unusable entry is one missing catalog row and
 * a diagnostic naming it, which is the same bargain snippets already make.
 */
export async function resolveMcpCatalog(
  servers: readonly McpServerDef[],
  reader: FileReader,
): Promise<Resolution<ResolvedMcpServerDef>> {
  return partitionResolutions(
    await Promise.all(servers.map((server) => resolveMcpServer(server, reader))),
  );
}

async function resolveMcpServer(
  server: McpServerDef,
  reader: FileReader,
): Promise<McpServerOutcome> {
  let path: string;
  try {
    const sourceUrl = new URL(server.source.url);
    if (sourceUrl.protocol !== "file:") {
      throw new Error("not a file: URL");
    }
    path = fileURLToPath(sourceUrl);
  } catch {
    return failedMcpServer(
      `MCP catalog entry "${server.id}" declares a source that is not an absolute file: URL, so its definition is unavailable.`,
      "files",
    );
  }

  const contents = await reader.read(path, { maxBytes: MAX_MCP_CATALOG_BYTES });
  const read = readMcpSource(server, path, contents);
  if (read.message !== undefined) {
    return failedMcpServer(read.message, "read", path);
  }

  const parsed = parseMcpServerManifest(read.content);
  if ("error" in parsed) {
    return failedMcpServer(
      `MCP catalog entry "${server.id}" is invalid at ${parsed.error.path}: ${parsed.error.message}, so its definition is unavailable.`,
      "parse",
      path,
    );
  }

  const mismatch = metadataMismatch(server, parsed.value);
  if (mismatch !== undefined) {
    return failedMcpServer(
      `MCP catalog entry "${server.id}" disagrees with its source file at $.${mismatch}, so its definition is unavailable.`,
      "parse",
      path,
    );
  }

  return { kind: "resolved", value: Object.freeze({ ...server, manifest: parsed.value }) };
}

/** Usable catalog JSON, or the one sentence saying why this read produced none. */
type McpSource =
  | { readonly content: string; readonly message?: undefined }
  | { readonly content?: undefined; readonly message: string };

function readMcpSource(server: McpServerDef, path: string, source: PathContents): McpSource {
  if (!source.exists) {
    // Inside a compiled executable a missing definition is a build mistake, not a broken machine:
    // the JSON was never embedded. Say what embeds it rather than blaming the filesystem.
    return {
      message: isEmbeddedAssetPath(path)
        ? `MCP catalog entry "${server.id}" was not embedded in this executable, so its definition is unavailable. Compile it with the catalog JSON as extra "bun build" entrypoints and "--loader .json:file".`
        : `MCP catalog entry "${server.id}" points at a file that does not exist, so its definition is unavailable.`,
    };
  }
  if (source.isDirectory) {
    return {
      message: `MCP catalog entry "${server.id}" points at a directory rather than a JSON file, so its definition is unavailable.`,
    };
  }
  // Covers anything that is neither a regular file nor a directory: reading a device or a FIFO
  // would block on open, so the reader reports it as unsupported instead of touching it.
  if (source.problem !== undefined || source.content === undefined) {
    return {
      message: `MCP catalog entry "${server.id}" could not be read (${source.problem ?? "unknown"}), so its definition is unavailable.`,
    };
  }
  // A truncated definition would parse as invalid JSON and blame the plugin author for a limit
  // they never hit, so size is reported as itself. Only populated when a bound was requested.
  if (source.size !== undefined && source.size > MAX_MCP_CATALOG_BYTES) {
    return {
      message: `MCP catalog entry "${server.id}" is larger than the ${String(MAX_MCP_CATALOG_BYTES)} byte catalog limit, so its definition is unavailable.`,
    };
  }
  return { content: source.content };
}

/**
 * The first field a contribution and its source file disagree about.
 *
 * Both spell the same three, and a picker that showed one while installing the other would be
 * lying about what it is about to write.
 */
function metadataMismatch(
  server: McpServerDef,
  manifest: McpServerManifest,
): "description" | "id" | "name" | undefined {
  for (const field of ["id", "name", "description"] as const) {
    if (server[field] !== manifest[field]) {
      return field;
    }
  }
  return undefined;
}

function failedMcpServer(
  message: string,
  phase: ScanDiagnostic["phase"],
  path?: string,
): McpServerOutcome {
  return failedResolution(MCP_DIAGNOSTIC_ID, message, phase, path);
}
