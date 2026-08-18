import { dirname } from "node:path";

import {
  detectExecutable,
  TIMEOUT_EXIT_CODE,
  type AdapterDetection,
  type Environment,
  type ExecResult,
} from "@tryaura/aura-sdk";

import {
  cursorMcpStatesMetadata,
  cursorMcpUnavailableMetadata,
  type CursorMcpStateMetadata,
} from "./contract.js";
import { parseCursorMcpRuntimeStates } from "./mcp-runtime-state.js";

/**
 * Bound on `cursor-agent mcp list`.
 *
 * Longer than the `--version` probe every search-path entry pays, because this command does more
 * than print a string: Cursor loads each configured server to report whether it is ready, and one
 * launched through `npx` or `uvx` can pay a package fetch the first time. A tighter bound did not
 * make the scan faster, it made the feature report nothing on the machines that most needed it,
 * and report it silently.
 */
const MCP_LIST_TIMEOUT_MS = 30_000;

/**
 * Detects Cursor, then reads its MCP runtime state when a verified `cursor-agent` is available.
 *
 * On Windows the installer puts a `cursor.cmd` shim into `resources\app\bin` and adds that
 * directory to the search path; there is no `cursor.exe` beside it, so the shim is what gets
 * probed, and `cursor-agent.cmd` is the companion CLI's spelling there. Cursor exposes no command
 * that reports credential state, so nothing here establishes whether the user is signed in.
 *
 * `cursor-agent mcp list` is not a passive read: Cursor connects to each configured server to say
 * whether it loaded. It therefore runs from {@link Environment.homeDir}, never the working
 * directory, so only the user's own global configuration takes part. A `.cursor/mcp.json`
 * committed to a repository names commands Aura must not launch on the strength of a clone, and
 * the working directory is exactly where Cursor would have found it.
 */
export async function detectCursor(environment: Environment): Promise<AdapterDetection> {
  const detection = await detectExecutable(environment, {
    binaryName: "cursor",
    windowsBinaryName: "cursor.cmd",
  });
  if (!detection.installed) {
    return detection;
  }

  const agent = await detectExecutable(environment, {
    binaryName: "cursor-agent",
    preferredDirectories: companionDirectories(detection.executablePath),
    windowsBinaryName: "cursor-agent.cmd",
  });
  if (agent.executablePath === undefined || agent.version === undefined) {
    // Nothing ran, so there is nothing to report: the companion CLI ships separately from the
    // editor and is absent on most machines, which is not a fault worth a diagnostic.
    return detection;
  }

  const listed = await environment.exec({
    args: ["mcp", "list"],
    command: agent.executablePath,
    cwd: environment.homeDir,
    timeoutMs: MCP_LIST_TIMEOUT_MS,
  });
  return { ...detection, metadata: { ...detection.metadata, ...runtimeStateMetadata(listed) } };
}

/**
 * The companion CLI is checked beside the editor before the search path is walked.
 *
 * Both land in one directory when they were installed together, and finding it there costs a
 * single spawn. The walk still runs when they were not, so an absent `cursor-agent` remains the
 * expensive case — a detect has no reader, and asking whether a file exists means running it.
 */
function companionDirectories(executablePath: string | undefined): readonly string[] {
  return executablePath === undefined ? [] : [dirname(executablePath)];
}

/**
 * What the listing contributed: the parsed states, or why they are missing.
 *
 * A verified CLI that then failed is worth recording. Reporting nothing would be indistinguishable
 * from reporting that every server is fine, and the user who runs a doctor is asking for the
 * difference.
 *
 * Only `stdout` is parsed. `stderr` is a third party's diagnostic prose, and the row names it
 * yields become keys in detection metadata, which is rendered.
 */
function runtimeStateMetadata(listed: ExecResult): CursorMcpStateMetadata {
  if (listed.exitCode === TIMEOUT_EXIT_CODE) {
    return cursorMcpUnavailableMetadata("timeout");
  }
  if (listed.exitCode !== 0) {
    return cursorMcpUnavailableMetadata("failed");
  }
  return cursorMcpStatesMetadata(parseCursorMcpRuntimeStates(listed.stdout));
}
