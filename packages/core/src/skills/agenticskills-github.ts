import type {
  DirectorySkillSource,
  Environment,
  ResolvedSkillFile,
  ResolvedSkillPack,
} from "@tryaura/aura-sdk";

import { createLimiter } from "../workspace/concurrency.js";
import { isRecord } from "../values.js";
import { treeHash } from "../workspace/skill-tree-walk.js";
import { agenticRequestFailure, getAgenticResource } from "./agenticskills-http.js";
import { listRemoteFiles, type RemoteFile } from "./agenticskills-tree.js";
import {
  GITHUB_API_HEADERS,
  type AgenticCatalogEntry,
  type GitHubLocation,
} from "./agenticskills-types.js";
import { rawFileUrl, repositoryTreeApiUrl } from "./agenticskills-urls.js";
import {
  MAX_CONCURRENT_SKILL_REQUESTS,
  MAX_REPO_TREE_BYTES,
  MAX_SKILL_FILE_BYTES,
} from "./limits.js";
import type { DirectorySkillVerification } from "./listing-verification.js";
import { parseDirectorySkillPack } from "./pack-schema.js";

/**
 * Starts one advisory recursive-tree check per repository without holding up the catalog listing.
 *
 * A complete tree can prove that an advertised root SKILL.md is absent. A failed, malformed,
 * oversized, or GitHub-truncated tree proves nothing, so that repository keeps trusting the feed.
 * Results are retained before any picker subscribes and notify live pickers as each repository
 * settles. Resolution remains authoritative and reports a per-skill failure for stale selections.
 */
export function startAgenticVerification(
  environment: Environment,
  entries: readonly AgenticCatalogEntry[],
): DirectorySkillVerification {
  const missing = new Set<string>();
  const listeners = new Set<() => void>();
  const repositories = groupByRepository(entries);
  const limit = createLimiter(MAX_CONCURRENT_SKILL_REQUESTS);
  const settled = Promise.all(
    repositories.map((repository) =>
      limit(async () => {
        let result: readonly string[];
        try {
          result = await verifyRepository(environment, repository);
        } catch {
          return;
        }
        if (result.length === 0) {
          return;
        }
        for (const id of result) {
          missing.add(id);
        }
        for (const listener of listeners) {
          listener();
        }
      }),
    ),
  ).then(() => undefined);

  return Object.freeze({
    isMissing: (skillId: string) => missing.has(skillId),
    settled,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

interface AgenticRepository {
  readonly entries: readonly AgenticCatalogEntry[];
  readonly location: GitHubLocation;
}

function groupByRepository(entries: readonly AgenticCatalogEntry[]): readonly AgenticRepository[] {
  const grouped = new Map<
    string,
    { readonly entries: AgenticCatalogEntry[]; readonly location: GitHubLocation }
  >();
  for (const entry of entries) {
    const location = entry.github;
    const key = `${location.owner}\0${location.repository}\0${location.ref}`;
    const repository = grouped.get(key);
    if (repository === undefined) {
      grouped.set(key, { entries: [entry], location });
    } else {
      repository.entries.push(entry);
    }
  }
  return [...grouped.values()].map((repository) => ({
    entries: Object.freeze(repository.entries),
    location: repository.location,
  }));
}

async function verifyRepository(
  environment: Environment,
  repository: AgenticRepository,
): Promise<readonly string[]> {
  const outcome = await getAgenticResource(
    environment,
    {
      headers: GITHUB_API_HEADERS,
      maxResponseBytes: MAX_REPO_TREE_BYTES,
      url: repositoryTreeApiUrl(repository.location),
    },
    false,
  );
  if (outcome.kind !== "text") {
    return [];
  }
  const published = parseRepositoryTree(outcome.body);
  if (published === undefined) {
    return [];
  }
  return repository.entries
    .filter((entry) => !published.has(`${entry.github.directory}/SKILL.md`))
    .map((entry) => entry.listing.id);
}

function parseRepositoryTree(body: string): ReadonlySet<string> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed["truncated"] !== false || !Array.isArray(parsed["tree"])) {
    return undefined;
  }
  const paths = new Set<string>();
  for (const value of parsed["tree"]) {
    const entry = parseRepositoryTreeEntry(value);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.type === "blob") {
      paths.add(entry.path);
    }
  }
  return paths;
}

interface RepositoryTreeEntry {
  readonly path: string;
  readonly type: string;
}

function parseRepositoryTreeEntry(value: unknown): RepositoryTreeEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const path = value["path"];
  const type = value["type"];
  return typeof path === "string" && typeof type === "string" ? { path, type } : undefined;
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
