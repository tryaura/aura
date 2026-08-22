import { chmod, lstat } from "node:fs/promises";

import { extractArchive, type ArchiveFailure } from "./archive.js";
import { MAX_EXTRACTED_BYTES } from "./limits.js";
import type { UpdateDownloadResult, UpdateHost } from "./host.js";
import type { UpdateCandidate } from "./types.js";

/** The closed vocabulary a refused transfer reports. */
type DownloadFailure = Extract<UpdateDownloadResult, { kind: "failure" }>["reason"];

/**
 * Why a candidate never became a staged executable.
 *
 * Each step keeps its own vocabulary rather than collapsing into one word. None of these reaches a
 * user — every staging failure is silent — but a distribution author whose updates are not
 * happening has no other way to tell a proxy stripping bytes from an archive the extractor refuses.
 */
export type StageFailure =
  /** The bytes arrived and were not the ones the release published a digest for. */
  | "digest"
  /** The transfer, named by the reason the download gave. */
  | `download-${DownloadFailure}`
  /** The archive, named by the shape the extractor refused. */
  | ArchiveFailure
  /** The staged file could not be made executable, or is not the version the metadata named. */
  | "staged-version";

export interface StageRequest {
  /** Temporary path the archive streams to. */
  readonly archivePath: string;
  readonly candidate: UpdateCandidate;
  readonly downloadHeaders: Readonly<Record<string, string>>;
  /** What is left of the startup update's budget, which is all the transfer may spend. */
  readonly downloadTimeoutMs: number;
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
    expectedBytes: request.candidate.size,
    headers: request.downloadHeaders,
    ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
    timeoutMs: request.downloadTimeoutMs,
    url: request.candidate.downloadUrl,
  });
  if (download.kind !== "downloaded") {
    return `download-${download.reason}`;
  }
  if (download.sha256 !== request.candidate.sha256) {
    return "digest";
  }
  const archive = await extract(request);
  if (archive !== undefined) {
    return archive;
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
      return "staged-version";
    }
  } catch {
    return "staged-version";
  }
  const version = await request.host.probeVersion(request.stagedPath, request.probeEnvironment);
  return version === request.candidate.version ? undefined : "staged-version";
}
