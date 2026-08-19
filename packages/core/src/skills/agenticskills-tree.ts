import type { Environment } from "@tryaura/aura-sdk";

import { isRecord } from "../values.js";
import { createLimiter } from "../workspace/concurrency.js";
import { agenticRequestFailure, getAgenticResource } from "./agenticskills-http.js";
import { GITHUB_API_HEADERS, type GitHubLocation } from "./agenticskills-types.js";
import { contentsApiUrl } from "./agenticskills-urls.js";
import {
  MAX_CONCURRENT_SKILL_REQUESTS,
  MAX_DIRECTORY_INDEX_BYTES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_RESPONSE_BYTES,
} from "./limits.js";
import { skillFilePathProblem } from "./path-guards.js";

export interface RemoteFile {
  /** Workspace-relative path inside the installed skill. */
  readonly path: string;
  /** Path inside the repository, which the skill's own directory prefixes. */
  readonly remotePath: string;
}

/**
 * The bounds accumulated across the whole walk, plus the directories the next level will list.
 *
 * `directoryCount` counts every directory the walk has ever queued, not the current level: a tree
 * that stays narrow at each level but never terminates has to hit the same ceiling as a wide one.
 */
interface TreeState {
  declaredBytes: number;
  directoryCount: number;
  readonly files: RemoteFile[];
  readonly pending: RemoteFile[];
}

/**
 * Walks the skill's directory tree one level at a time, listing each level concurrently.
 *
 * Requests within a level overlap under the shared limiter, but the responses are folded in level
 * order and, within a level, in request order — so which entry trips a bound does not depend on
 * which response happened to land first, and a hostile tree cannot reorder its way past one.
 */
export async function listRemoteFiles(
  environment: Environment,
  location: GitHubLocation,
): Promise<readonly RemoteFile[] | string> {
  const limit = createLimiter(MAX_CONCURRENT_SKILL_REQUESTS);
  const state: TreeState = { declaredBytes: 0, directoryCount: 1, files: [], pending: [] };
  let level: readonly RemoteFile[] = [{ path: "", remotePath: location.directory }];

  while (level.length > 0) {
    const listings = await Promise.all(
      level.map((directory) =>
        limit(async () => ({
          directory,
          outcome: await getAgenticResource(environment, {
            headers: GITHUB_API_HEADERS,
            maxResponseBytes: MAX_DIRECTORY_INDEX_BYTES,
            url: contentsApiUrl(location, directory.remotePath),
          }),
        })),
      ),
    );
    state.pending.length = 0;
    for (const { directory, outcome } of listings) {
      const problem = foldListing(directory, outcome, state);
      if (problem !== undefined) {
        return problem;
      }
    }
    level = [...state.pending];
  }
  return Object.freeze(state.files);
}

// fallow-ignore-next-line complexity -- every branch bounds or refuses one hostile tree entry.
function foldListing(
  directory: RemoteFile,
  outcome: Awaited<ReturnType<typeof getAgenticResource>>,
  state: TreeState,
): string | undefined {
  if (outcome.kind === "failure") {
    return agenticRequestFailure(outcome.reason);
  }
  if (outcome.kind !== "text") {
    return "repository directory listing was not text";
  }
  const entries = parseContents(outcome.body);
  if (typeof entries === "string") {
    return entries;
  }
  for (const entry of entries) {
    const path = directory.path === "" ? entry.name : `${directory.path}/${entry.name}`;
    if (skillFilePathProblem(path) !== undefined) {
      return "repository contains a non-portable path";
    }
    const remotePath =
      directory.remotePath === "" ? entry.name : `${directory.remotePath}/${entry.name}`;
    if (entry.type === "dir") {
      if (state.directoryCount >= MAX_SKILL_FILES) {
        return `contains more than ${String(MAX_SKILL_FILES)} directories`;
      }
      state.directoryCount += 1;
      state.pending.push(Object.freeze({ path, remotePath }));
    } else if (entry.type === "file") {
      const problem = foldFile(entry, path, remotePath, state);
      if (problem !== undefined) {
        return problem;
      }
    }
  }
  return undefined;
}

function foldFile(
  entry: GitHubContentEntry,
  path: string,
  remotePath: string,
  state: TreeState,
): string | undefined {
  if (entry.size > MAX_SKILL_FILE_BYTES) {
    return `contains a file larger than the ${String(MAX_SKILL_FILE_BYTES)} byte limit`;
  }
  if (state.files.length >= MAX_SKILL_FILES) {
    return `contains more than ${String(MAX_SKILL_FILES)} files`;
  }
  state.declaredBytes += entry.size;
  if (state.declaredBytes > MAX_SKILL_RESPONSE_BYTES) {
    return `contains more than the ${String(MAX_SKILL_RESPONSE_BYTES)} byte limit`;
  }
  state.files.push(Object.freeze({ path, remotePath }));
  return undefined;
}

interface GitHubContentEntry {
  readonly name: string;
  readonly size: number;
  readonly type: "dir" | "file" | "other";
}

// fallow-ignore-next-line complexity -- every branch rejects one malformed GitHub response shape.
function parseContents(body: string): readonly GitHubContentEntry[] | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "repository directory listing was not valid JSON";
  }
  if (!Array.isArray(parsed)) {
    return "repository URL did not identify a directory";
  }
  const entries: GitHubContentEntry[] = [];
  for (const value of parsed) {
    if (!isRecord(value)) {
      return "repository directory listing contained an invalid entry";
    }
    const name = value["name"];
    const size = value["size"];
    const type = value["type"];
    if (
      typeof name !== "string" ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      typeof type !== "string"
    ) {
      return "repository directory listing contained an invalid entry";
    }
    entries.push({
      name,
      size,
      type: type === "dir" || type === "file" ? type : "other",
    });
  }
  return Object.freeze(entries);
}
