import { chmod, lstat } from "node:fs/promises";

import { extractArchive } from "./archive.js";
import { MAX_EXTRACTED_BYTES } from "./limits.js";
import type { UpdateHost } from "./host.js";
import type { CliUpdateCandidate } from "./types.js";

/** Why a candidate never became a staged executable. */
export type StageFailure =
  /** The bytes never arrived, or arrived in the wrong quantity. */
  | "download"
  /** The bytes arrived and were not the ones the release published a digest for. */
  | "digest"
  /** The archive was not exactly the two expected files. */
  | "archive"
  /** The staged program does not report the version the release claimed it would. */
  | "verification";

export interface StageRequest {
  /** Temporary path the archive streams to. */
  readonly archivePath: string;
  readonly candidate: CliUpdateCandidate;
  readonly downloadHeaders: Readonly<Record<string, string>>;
  /** Name of the executable inside the archive, which is the distribution's command name. */
  readonly entryName: string;
  /** Permission bits of the executable being replaced. */
  readonly executableMode: number;
  readonly host: UpdateHost;
  /** Temporary path the archive's `LICENSE` extracts to. */
  readonly licensePath: string;
  /** Drawn while the archive streams, when the caller has a terminal to draw on. */
  readonly onProgress?: ((received: number, total: number) => void) | undefined;
  /**
   * Environment the staged program is asked its version in.
   *
   * Carries the distribution's own disable variable, so verifying an update can never start one.
   */
  readonly probeEnvironment: Readonly<Record<string, string>>;
  /** Temporary path the executable extracts to, on the same filesystem as the installed one. */
  readonly stagedPath: string;
}

/**
 * Turns a validated candidate into a verified executable sitting next to the installed one.
 *
 * Nothing here touches the installed binary. Every failure leaves temporary files for the caller
 * to remove and the running installation exactly as it was — which is the property that makes an
 * update safe to attempt on every startup.
 */
export async function stageExecutable(request: StageRequest): Promise<StageFailure | undefined> {
  const download = await request.host.download({
    destinationPath: request.archivePath,
    expectedBytes: request.candidate.archive.size,
    headers: request.downloadHeaders,
    ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
    url: request.candidate.archive.downloadUrl,
  });
  if (download.kind !== "downloaded") {
    return "download";
  }
  if (download.sha256 !== request.candidate.archive.sha256) {
    return "digest";
  }
  if ((await extract(request)) !== undefined) {
    return "archive";
  }
  return await verifyStaged(request);
}

function extract(request: StageRequest): ReturnType<typeof extractArchive> {
  return extractArchive({
    archivePath: request.archivePath,
    entries: { LICENSE: request.licensePath, [request.entryName]: request.stagedPath },
    maxBytes: MAX_EXTRACTED_BYTES,
    requiredEntry: request.entryName,
  });
}

/**
 * Proves the staged file is an executable that agrees about which version it is.
 *
 * This is the last gate before anything irreversible. A digest proves the bytes match a published
 * release; running the program proves the release is the one the metadata named, that it starts on
 * this machine at all, and that its architecture is the one this process is running.
 */
async function verifyStaged(request: StageRequest): Promise<StageFailure | undefined> {
  try {
    await chmod(request.stagedPath, request.executableMode);
    if (!(await lstat(request.stagedPath)).isFile()) {
      return "verification";
    }
  } catch {
    return "verification";
  }
  const version = await request.host.probeVersion(request.stagedPath, request.probeEnvironment);
  return version === request.candidate.version ? undefined : "verification";
}
