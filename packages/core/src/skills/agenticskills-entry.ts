import { isRecord } from "../values.js";
import type { AgenticCatalogEntry, GitHubLocation } from "./agenticskills-types.js";
import { skillIdProblem } from "./path-guards.js";

const GITHUB_SEGMENT = /^[A-Za-z0-9._-]+$/u;

/** A feed entry pointing at a whole repository rather than a skill directory; silently skipped. */
export const UNSUPPORTED_COLLECTION = Symbol("unsupported-collection");

// fallow-ignore-next-line complexity -- every branch rejects one incomplete provider entry.
export function parseCatalogEntry(
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
