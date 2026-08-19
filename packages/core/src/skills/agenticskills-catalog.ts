import type { DirectorySkillSource, Environment } from "@tryaura/aura-sdk";

import { isRecord } from "../values.js";
import { agenticRequestFailure, getAgenticResource } from "./agenticskills-http.js";
import type {
  AgenticCatalogEntry,
  AgenticCatalogOutcome,
  GitHubLocation,
} from "./agenticskills-types.js";
import { MAX_DIRECTORY_INDEX_BYTES, MAX_DIRECTORY_INDEX_ENTRIES } from "./limits.js";
import { skillIdProblem } from "./path-guards.js";

const GITHUB_SEGMENT = /^[A-Za-z0-9._-]+$/u;
const UNSUPPORTED_COLLECTION = Symbol("unsupported-collection");

/**
 * The feed each endpoint served, scoped to the environment that fetched it.
 *
 * Listing and resolving are separate entry points that both need the whole feed, and resolving
 * runs after the user has picked — refetching there costs a second full download and can disagree
 * with the catalog the picker was built from. Memoizing makes the two agree by construction.
 * Keying on the environment rather than the module keeps one run's answers out of the next one's.
 */
const catalogs = new WeakMap<Environment, Map<string, Promise<AgenticCatalogOutcome>>>();

export function loadAgenticCatalog(
  environment: Environment,
  source: DirectorySkillSource,
): Promise<AgenticCatalogOutcome> {
  const endpoint = providerEndpoint(source.url);
  if (endpoint === undefined) {
    return Promise.resolve({ kind: "failure", reason: "has a URL that does not parse" });
  }
  const byEndpoint = catalogs.get(environment) ?? new Map<string, Promise<AgenticCatalogOutcome>>();
  catalogs.set(environment, byEndpoint);
  const memoized = byEndpoint.get(endpoint);
  if (memoized !== undefined) {
    return memoized;
  }
  const pending = fetchCatalog(environment, endpoint);
  byEndpoint.set(endpoint, pending);
  return pending;
}

async function fetchCatalog(
  environment: Environment,
  endpoint: string,
): Promise<AgenticCatalogOutcome> {
  const outcome = await getAgenticResource(environment, {
    maxResponseBytes: MAX_DIRECTORY_INDEX_BYTES,
    url: endpoint,
  });
  if (outcome.kind === "failure") {
    return { kind: "failure", reason: agenticRequestFailure(outcome.reason) };
  }
  if (outcome.kind !== "text") {
    return { kind: "failure", reason: "returned a non-text catalog" };
  }
  return parseCatalog(outcome.body);
}

function providerEndpoint(baseUrl: string): string | undefined {
  try {
    const base = new URL(baseUrl);
    base.pathname = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
    return new URL("api/skills", base).href;
  } catch {
    return undefined;
  }
}

// fallow-ignore-next-line complexity -- every branch drops or bounds one untrusted feed shape.
function parseCatalog(body: string): AgenticCatalogOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "failure", reason: "returned a catalog that is not valid JSON" };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["skills"])) {
    return { kind: "failure", reason: "returned a catalog without a skills array" };
  }

  const entries: AgenticCatalogEntry[] = [];
  const seen = new Set<string>();
  let malformed = 0;
  const advertised = parsed["skills"];
  for (const candidate of advertised.slice(0, MAX_DIRECTORY_INDEX_ENTRIES)) {
    const entry = parseCatalogEntry(candidate);
    if (entry === UNSUPPORTED_COLLECTION) {
      continue;
    }
    if (entry === undefined || seen.has(entry.listing.id)) {
      malformed += 1;
      continue;
    }
    seen.add(entry.listing.id);
    entries.push(entry);
  }
  const problems: string[] = [];
  if (advertised.length > MAX_DIRECTORY_INDEX_ENTRIES) {
    problems.push(
      `advertises ${String(advertised.length)} entries; only the first ${String(MAX_DIRECTORY_INDEX_ENTRIES)} are read`,
    );
  }
  if (malformed > 0) {
    problems.push(`contains ${String(malformed)} malformed or duplicate entries`);
  }
  return {
    entries: Object.freeze(entries),
    kind: "catalog",
    problems: Object.freeze(problems),
  };
}

// fallow-ignore-next-line complexity -- every branch rejects one incomplete provider entry.
function parseCatalogEntry(
  value: unknown,
): AgenticCatalogEntry | typeof UNSUPPORTED_COLLECTION | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const description = value["description"];
  const githubUrl = value["githubUrl"];
  const id = value["slug"];
  const lastUpdated = value["lastUpdated"];
  const name = value["name"];
  if (
    typeof description !== "string" ||
    typeof githubUrl !== "string" ||
    typeof id !== "string" ||
    typeof lastUpdated !== "string" ||
    typeof name !== "string" ||
    skillIdProblem(id) !== undefined
  ) {
    return undefined;
  }
  const github = parseGitHubUrl(githubUrl);
  const version = dateVersion(lastUpdated);
  if (github === UNSUPPORTED_COLLECTION) {
    return github;
  }
  if (github === undefined || version === undefined) {
    return undefined;
  }
  return Object.freeze({
    github,
    listing: Object.freeze({ description, id, name, originUrl: githubOrigin(github), version }),
  });
}

/**
 * The exact GitHub directory a listing installs from, rebuilt from the vetted components.
 *
 * Rebuilt rather than echoed: the feed's own string has already been through
 * {@link parseGitHubUrl}, and re-printing the parts that survived it is what keeps a rejected
 * userinfo, query, or fragment from reappearing on screen as if Aura had accepted it.
 */
function githubOrigin(location: GitHubLocation): string {
  return `https://github.com/${location.owner}/${location.repository}/tree/${location.ref}/${location.directory}`;
}

// fallow-ignore-next-line complexity -- every branch confines one untrusted URL component.
function parseGitHubUrl(value: string): GitHubLocation | typeof UNSUPPORTED_COLLECTION | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const owner = segments[0];
  const repository = segments[1];
  if (
    owner === undefined ||
    repository === undefined ||
    !GITHUB_SEGMENT.test(owner) ||
    !GITHUB_SEGMENT.test(repository)
  ) {
    return undefined;
  }
  if (segments.length === 2) {
    return UNSUPPORTED_COLLECTION;
  }
  const ref = segments[3];
  const directorySegments = segments.slice(4);
  if (
    segments[2] !== "tree" ||
    ref === undefined ||
    !GITHUB_SEGMENT.test(ref) ||
    directorySegments.length === 0 ||
    directorySegments.some((segment) => !GITHUB_SEGMENT.test(segment))
  ) {
    return undefined;
  }
  return Object.freeze({
    directory: directorySegments.join("/"),
    owner,
    ref,
    repository,
  });
}

function dateVersion(value: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const days = daysInMonth(year, month);
  if (year === 0 || days === undefined || day < 1 || day > days) {
    return undefined;
  }
  return `${String(year)}.${String(month)}.${String(day)}`;
}

function daysInMonth(year: number, month: number): number | undefined {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  if ([4, 6, 9, 11].includes(month)) {
    return 30;
  }
  return month >= 1 && month <= 12 ? 31 : undefined;
}
