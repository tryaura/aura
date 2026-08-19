import type {
  DriverSkillListing,
  DriverSkillPack,
  DriverSkillSource,
  Environment,
  ResolvedSkillListing,
  ResolvedSkillPack,
} from "@tryaura/aura-sdk";

import { isAllowedHttpUrl } from "../http.boundary.js";
import { contentVersionProblem } from "../plugin-validation-version.js";
import { createCachingReader, createFileReader, type FileReader } from "../workspace/reader.js";
import { resolveDriverSkillPack } from "../workspace/skills.js";
import { MAX_DIRECTORY_INDEX_ENTRIES, MAX_SKILL_DRIVER_CALL_MS } from "./limits.js";
import { skillIdProblem } from "./path-guards.js";

/** What a driver call that outlived {@link MAX_SKILL_DRIVER_CALL_MS} resolves to instead. */
const TIMED_OUT = Symbol("driver-call-timed-out");

export interface DriverSkillListingResult {
  readonly messages: readonly string[];
  readonly listings: readonly ResolvedSkillListing[];
  readonly status: "available" | "unavailable";
}

export interface DriverSkillResolutionResult {
  readonly problems: ReadonlyMap<string, string>;
  readonly skills: readonly ResolvedSkillPack[];
}

/** Calls and validates one driver listing without allowing its raw failure data into output. */
export async function listDriverSkills(
  environment: Environment,
  source: DriverSkillSource,
): Promise<DriverSkillListingResult> {
  let returned: readonly DriverSkillListing[] | typeof TIMED_OUT;
  try {
    returned = await withDeadline(() => source.driver.list(environment));
  } catch {
    return unavailableListing(source.id, "could not be listed");
  }
  if (returned === TIMED_OUT) {
    return unavailableListing(source.id, "did not finish listing in time");
  }
  if (!Array.isArray(returned)) {
    return unavailableListing(source.id, "returned an invalid listing");
  }

  const listings: ResolvedSkillListing[] = [];
  const messages: string[] = [];
  const seen = new Set<string>();
  if (returned.length > MAX_DIRECTORY_INDEX_ENTRIES) {
    messages.push(
      `Skill source "${source.id}" returned too many listings; only the first ${String(MAX_DIRECTORY_INDEX_ENTRIES)} were considered.`,
    );
  }
  for (const [index, candidate] of returned.slice(0, MAX_DIRECTORY_INDEX_ENTRIES).entries()) {
    if (!validListing(candidate, seen)) {
      messages.push(
        `Skill source "${source.id}" listing ${String(index + 1)} is invalid, so it is unavailable.`,
      );
      continue;
    }
    seen.add(candidate.id);
    listings.push(Object.freeze({ ...candidate, source }));
  }
  return {
    listings: Object.freeze(listings),
    messages: Object.freeze(messages),
    status: "available",
  };
}

/** Resolves one selected batch and safely normalizes each returned directory independently. */
export async function resolveDriverSkills(
  environment: Environment,
  source: DriverSkillSource,
  skillIds: readonly string[],
  reader: FileReader = createCachingReader(createFileReader()),
): Promise<DriverSkillResolutionResult> {
  const ids = [...new Set(skillIds)].filter((id) => skillIdProblem(id) === undefined);
  let returned: ReadonlyMap<string, DriverSkillPack> | typeof TIMED_OUT;
  try {
    returned = await withDeadline(() => source.driver.resolve(environment, Object.freeze(ids)));
  } catch {
    return failedBatch(ids, "could not be resolved from its source");
  }
  if (returned === TIMED_OUT) {
    return failedBatch(ids, "was not resolved by its source in time");
  }
  if (!(returned instanceof Map)) {
    return failedBatch(ids, "could not be resolved from its source");
  }

  const skills: ResolvedSkillPack[] = [];
  const problems = new Map<string, string>();
  for (const id of ids) {
    const candidate = returned.get(id);
    if (!validPack(candidate, id)) {
      problems.set(id, "returned an invalid skill directory");
      continue;
    }
    const resolved = await resolveDriverSkillPack(candidate, source, reader);
    if (resolved.kind === "invalid") {
      problems.set(id, "returned an unsafe or unreadable skill directory");
      continue;
    }
    skills.push(resolved.value);
  }
  return { problems, skills: Object.freeze(skills) };
}

// fallow-ignore-next-line complexity -- every conjunct is one independent hostile-listing guard.
function validListing(candidate: DriverSkillListing, seen: ReadonlySet<string>): boolean {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.id === "string" &&
    skillIdProblem(candidate.id) === undefined &&
    !seen.has(candidate.id) &&
    nonEmpty(candidate.name) &&
    nonEmpty(candidate.description) &&
    typeof candidate.version === "string" &&
    contentVersionProblem(candidate.version) === undefined &&
    originUrlProblem(candidate.originUrl) === undefined
  );
}

function validPack(
  candidate: DriverSkillPack | undefined,
  expectedId: string,
): candidate is DriverSkillPack {
  return (
    candidate !== undefined &&
    validListing(candidate, new Set()) &&
    candidate.id === expectedId &&
    candidate.kind === "skill-pack" &&
    candidate.source?.type === "directory" &&
    typeof candidate.source.url === "string"
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function originUrlProblem(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return "missing";
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "invalid";
  }
  return !isAllowedHttpUrl(url) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
    ? "unsafe"
    : undefined;
}

function failedBatch(ids: readonly string[], reason: string): DriverSkillResolutionResult {
  return {
    problems: new Map(ids.map((id) => [id, reason])),
    skills: [],
  };
}

function unavailableListing(sourceId: string, reason: string): DriverSkillListingResult {
  return {
    listings: [],
    messages: [`Skill source "${sourceId}" ${reason}, so it is unavailable.`],
    status: "unavailable",
  };
}

/**
 * Bounds the wait on one driver call, which the driver protocol gives Aura no way to cancel.
 *
 * The abandoned call keeps running; what this guarantees is that the wizard stops waiting on it.
 * Its eventual settlement is consumed here so a late rejection cannot surface as an unhandled one,
 * and the timer is unreferenced so a driver that never settles cannot hold the process open.
 */
function withDeadline<T>(call: () => Promise<T>): Promise<T | typeof TIMED_OUT> {
  return new Promise<T | typeof TIMED_OUT>((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(TIMED_OUT);
    }, MAX_SKILL_DRIVER_CALL_MS);
    timer.unref();
    Promise.resolve()
      .then(call)
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timer);
      });
  });
}
