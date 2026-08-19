import type {
  DirectorySkillSource,
  Environment,
  ResolvedSkillFile,
  ResolvedSkillPack,
} from "@tryaura/aura-sdk";

import { createLimiter } from "../workspace/concurrency.js";
import { treeHash } from "../workspace/skill-tree-walk.js";
import { agenticRequestFailure, getAgenticResource } from "./agenticskills-http.js";
import { listRemoteFiles, type RemoteFile } from "./agenticskills-tree.js";
import { type AgenticCatalogEntry, type GitHubLocation } from "./agenticskills-types.js";
import { rawFileUrl } from "./agenticskills-urls.js";
import {
  MAX_CONCURRENT_SKILL_PROBES,
  MAX_CONCURRENT_SKILL_REQUESTS,
  MAX_SKILL_FILE_BYTES,
} from "./limits.js";
import { parseDirectorySkillPack } from "./pack-schema.js";

export interface VerifiedAgenticEntries {
  readonly entries: readonly AgenticCatalogEntry[];
  readonly failures: number;
}

/**
 * Drops picker rows for GitHub directories that no longer publish a root SKILL.md.
 *
 * Only a definite 404 removes an entry. A probe that failed for any other reason — a timeout, a
 * rate limit, a network blip — keeps its entry listed: the sweep is advisory, and dropping a real
 * skill because one request lost a race leaves the user with no row to select and no way to ask
 * again. Such an entry resolves like any other, and says why on its review row if it truly cannot
 * be fetched.
 */
export async function verifyAgenticEntries(
  environment: Environment,
  entries: readonly AgenticCatalogEntry[],
): Promise<VerifiedAgenticEntries> {
  const limit = createLimiter(MAX_CONCURRENT_SKILL_PROBES);
  const outcomes = await Promise.all(
    entries.map((entry) =>
      limit(async () => ({ entry, result: await probeDefinition(environment, entry.github) })),
    ),
  );
  return Object.freeze({
    entries: Object.freeze(
      outcomes.flatMap(({ entry, result }) => (result === "missing" ? [] : [entry])),
    ),
    failures: outcomes.filter(({ result }) => result === "failure").length,
  });
}

async function probeDefinition(
  environment: Environment,
  location: GitHubLocation,
): Promise<"available" | "failure" | "missing"> {
  const outcome = await getAgenticResource(
    environment,
    {
      maxResponseBytes: 64_000,
      responseType: "bytes",
      url: rawFileUrl(location, `${location.directory}/SKILL.md`),
    },
    false,
  );
  if (outcome.kind !== "failure" || outcome.reason === "response-too-large") {
    return "available";
  }
  return outcome.reason === "responded with HTTP 404" ? "missing" : "failure";
}

export async function resolveAgenticEntry(
  environment: Environment,
  source: DirectorySkillSource,
  entry: AgenticCatalogEntry,
): Promise<ResolvedSkillPack | string> {
  const remoteFiles = await listRemoteFiles(environment, entry.github);
  if (typeof remoteFiles === "string") {
    return remoteFiles;
  }
  const files = await downloadFiles(environment, entry.github, remoteFiles);
  if (typeof files === "string") {
    return files;
  }
  const parsed = parseDirectorySkillPack(
    JSON.stringify({ ...entry.listing, files }),
    entry.listing.id,
  );
  if (parsed.kind === "invalid") {
    return parsed.problem;
  }
  return Object.freeze({
    ...parsed.listing,
    files: parsed.files,
    source,
    treeHash: treeHash(parsed.files),
  });
}

async function downloadFiles(
  environment: Environment,
  location: GitHubLocation,
  remoteFiles: readonly RemoteFile[],
): Promise<readonly ResolvedSkillFile[] | string> {
  const limit = createLimiter(MAX_CONCURRENT_SKILL_REQUESTS);
  const outcomes = await Promise.all(
    remoteFiles.map((file) =>
      limit(async (): Promise<ResolvedSkillFile | string | undefined> => {
        const outcome = await getAgenticResource(environment, {
          maxResponseBytes: MAX_SKILL_FILE_BYTES,
          responseType: "bytes",
          url: rawFileUrl(location, file.remotePath),
        });
        if (outcome.kind === "failure") {
          return agenticRequestFailure(outcome.reason);
        }
        if (outcome.kind !== "bytes") {
          return "repository file response was not binary-safe";
        }
        try {
          return Object.freeze({
            content: new TextDecoder("utf-8", { fatal: true }).decode(outcome.body),
            path: file.path,
          });
        } catch {
          return undefined;
        }
      }),
    ),
  );
  const failure = outcomes.find((outcome): outcome is string => typeof outcome === "string");
  if (failure !== undefined) {
    return failure;
  }
  return Object.freeze(
    outcomes.filter((outcome): outcome is ResolvedSkillFile => outcome !== undefined),
  );
}
