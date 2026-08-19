import type {
  DirectorySkillSource,
  Environment,
  HttpGetResult,
  ResolvedSkillListing,
  ResolvedSkillPack,
} from "@tryaura/aura-sdk";

import type { ScanDiagnostic } from "../workspace/diagnostics.js";
import { isAllowedHttpUrl } from "../http.boundary.js";
import { createLimiter } from "../workspace/concurrency.js";
import { failedResolution, partitionResolutions } from "../workspace/resolution.js";
import { treeHash } from "../workspace/skills.js";
import { listAgenticSkills, resolveAgenticSkills } from "./agenticskills-client.js";
import { parseDirectoryIndex } from "./index-schema.js";
import {
  MAX_CONCURRENT_SKILL_REQUESTS,
  MAX_DIRECTORY_INDEX_BYTES,
  MAX_SKILL_RESPONSE_BYTES,
} from "./limits.js";
import { parseDirectorySkillPack } from "./pack-schema.js";
import { skillIdProblem } from "./path-guards.js";

const DIRECTORY_DIAGNOSTIC_ID = "core/skill-directory";

/** Everything one directory listing produced, including why it produced nothing. */
export interface DirectorySkillListingResult {
  readonly diagnostics: readonly ScanDiagnostic[];
  readonly listings: readonly ResolvedSkillListing[];
  /** How the source should appear in a picker when it cannot be listed. */
  readonly status:
    | { readonly kind: "available" }
    | { readonly hint: string; readonly kind: "unavailable" };
}

/**
 * Fetches a directory's index.
 *
 * A missing token is the probe outcome, not an error: the source lists as unavailable with the
 * variable to set, no request is made, and nothing is logged. Every other failure becomes one
 * diagnostic in the house voice. The token itself is read at request time inside {@link request}
 * and structurally cannot reach a diagnostic: {@link HttpGetResult} carries no request echo.
 */
export async function listDirectorySkills(
  environment: Environment,
  source: DirectorySkillSource,
): Promise<DirectorySkillListingResult> {
  if (source.kind === "directory" && source.protocol === "agenticskills") {
    return listAgenticSkills(environment, source);
  }
  const outcome = await request(environment, source, "index.json", MAX_DIRECTORY_INDEX_BYTES);
  if (outcome.kind === "missing-token") {
    return {
      diagnostics: [],
      listings: [],
      status: { hint: `set ${outcome.variable}`, kind: "unavailable" },
    };
  }
  if (outcome.kind !== "response") {
    return unavailable(source, outcome);
  }
  if (outcome.status !== 200) {
    return unavailable(source, outcome);
  }

  const index = parseDirectoryIndex(outcome.body);
  return {
    diagnostics: index.problems.map((problem) => ({
      adapterId: DIRECTORY_DIAGNOSTIC_ID,
      message: `Skill source "${source.id}" index ${problem}, so some of it is unavailable.`,
      phase: "read",
    })),
    listings: index.listings.map((listing) => Object.freeze({ ...listing, source })),
    status: { kind: "available" },
  };
}

/** Fetches and validates the named skills, one failure per skill rather than one for all. */
export async function resolveDirectorySkills(
  environment: Environment,
  source: DirectorySkillSource,
  skillIds: readonly string[],
): Promise<{
  readonly diagnostics: readonly ScanDiagnostic[];
  readonly skills: readonly ResolvedSkillPack[];
}> {
  if (source.kind === "directory" && source.protocol === "agenticskills") {
    return resolveAgenticSkills(environment, source, skillIds);
  }
  const limit = createLimiter(MAX_CONCURRENT_SKILL_REQUESTS);
  const outcomes = await Promise.all(
    skillIds.map((skillId) =>
      limit(async () => {
        const reason = await resolveProblem(environment, source, skillId);
        if (typeof reason === "string") {
          return failedResolution<ResolvedSkillPack>(
            DIRECTORY_DIAGNOSTIC_ID,
            `Skill "${safeId(skillId)}" from "${source.id}" ${reason}, so it is unavailable.`,
            "read",
          );
        }
        return { kind: "resolved" as const, value: reason };
      }),
    ),
  );

  const { diagnostics, values } = partitionResolutions(outcomes);
  return { diagnostics, skills: values };
}

/** One resolved pack, or the reason fragment for its diagnostic. */
async function resolveProblem(
  environment: Environment,
  source: DirectorySkillSource,
  skillId: string,
): Promise<ResolvedSkillPack | string> {
  if (skillIdProblem(skillId) !== undefined) {
    return skillIdProblem(skillId) ?? "has an invalid ID";
  }

  const outcome = await request(environment, source, `skills/${skillId}`, MAX_SKILL_RESPONSE_BYTES);
  if (outcome.kind === "missing-token") {
    return `needs the ${outcome.variable} environment variable`;
  }
  if (outcome.kind !== "response") {
    return failureReasonText(outcome.reason);
  }
  if (outcome.status !== 200) {
    return statusReasonText(source, outcome.status);
  }

  const pack = parseDirectorySkillPack(outcome.body, skillId);
  if (pack.kind === "invalid") {
    return pack.problem;
  }
  return Object.freeze({
    ...pack.listing,
    files: pack.files,
    source,
    treeHash: treeHash(pack.files),
  });
}

type RequestOutcome =
  | { readonly kind: "failure"; readonly reason: string }
  | { readonly kind: "missing-token"; readonly variable: string }
  | { readonly body: string; readonly kind: "response"; readonly status: number };

/**
 * Performs one authenticated GET against the directory, retrying exactly once on a transient
 * failure. The token is read here, at request time, into a call-local header object; it exists
 * nowhere else and outlives nothing.
 */
async function request(
  environment: Environment,
  source: DirectorySkillSource,
  path: string,
  maxResponseBytes: number,
): Promise<RequestOutcome> {
  const endpoint = directoryEndpoint(source.url, path);
  if (endpoint.kind === "failure") {
    return endpoint;
  }

  const headers: Record<string, string> = {};
  const variable = tokenVariable(source);
  if (variable !== undefined) {
    const token = environment.readVariable(variable);
    if (token === undefined) {
      return { kind: "missing-token", variable };
    }
    headers["Authorization"] = `Bearer ${token}`;
  }

  const first = await environment.httpGet({ headers, maxResponseBytes, url: endpoint.url });
  const result = isTransient(first)
    ? await environment.httpGet({ headers, maxResponseBytes, url: endpoint.url })
    : first;
  if (result.kind === "failure") {
    return { kind: "failure", reason: result.reason };
  }
  if (result.kind !== "response") {
    return { kind: "failure", reason: "network" };
  }
  return { body: result.body, kind: "response", status: result.status };
}
type DirectoryEndpoint =
  | { readonly kind: "failure"; readonly reason: "insecure-url" | "invalid-url" }
  | { readonly kind: "url"; readonly url: string };

/** Resolves one protocol path below a normalized directory base URL. */
function directoryEndpoint(baseUrl: string, path: string): DirectoryEndpoint {
  try {
    const base = new URL(baseUrl);
    if (!isAllowedHttpUrl(base)) {
      return { kind: "failure", reason: "insecure-url" };
    }
    if (base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== "") {
      return { kind: "failure", reason: "invalid-url" };
    }
    base.pathname = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
    return { kind: "url", url: new URL(path, base).href };
  } catch {
    return { kind: "failure", reason: "invalid-url" };
  }
}

/** A failed request or a 5xx answer may be a blip; anything else would fail identically again. */
function isTransient(result: HttpGetResult): boolean {
  if (result.kind === "failure") {
    return result.reason === "network" || result.reason === "timeout";
  }
  return result.status >= 500;
}

function tokenVariable(source: DirectorySkillSource): string | undefined {
  return source.kind === "private-directory" ? source.tokenEnv : undefined;
}

/** An id safe to quote in a diagnostic: validated ids only, never raw caller or server bytes. */
function safeId(id: string): string {
  return skillIdProblem(id) === undefined ? id : "<invalid id>";
}

function unavailable(
  source: DirectorySkillSource,
  outcome: { readonly kind: "failure"; readonly reason: string } | { readonly status: number },
): DirectorySkillListingResult {
  const reason =
    "reason" in outcome
      ? failureReasonText(outcome.reason)
      : statusReasonText(source, outcome.status);
  const hint =
    "reason" in outcome ? failureHint(outcome.reason) : statusHint(source, outcome.status);
  return {
    diagnostics: [
      {
        adapterId: DIRECTORY_DIAGNOSTIC_ID,
        message: `Skill source "${source.id}" ${reason}, so it is unavailable.`,
        phase: "read",
      },
    ],
    listings: [],
    status: { hint, kind: "unavailable" },
  };
}

function failureReasonText(reason: string): string {
  switch (reason) {
    case "insecure-url": {
      return "has a URL that is not https";
    }
    case "invalid-url": {
      return "has a URL that does not parse";
    }
    case "response-too-large": {
      return "sent a response larger than Aura reads";
    }
    case "timeout": {
      return "did not respond in time";
    }
    default: {
      return "could not be reached";
    }
  }
}

function failureHint(reason: string): string {
  switch (reason) {
    case "insecure-url":
    case "invalid-url": {
      return "fix the directory URL";
    }
    case "response-too-large": {
      return "index too large";
    }
    case "timeout": {
      return "timed out";
    }
    default: {
      return "unreachable";
    }
  }
}

function statusReasonText(source: DirectorySkillSource, status: number): string {
  const variable = tokenVariable(source);
  if ((status === 401 || status === 403) && variable !== undefined) {
    return `rejected the token from ${variable}`;
  }
  return `responded with HTTP ${String(status)}`;
}

function statusHint(source: DirectorySkillSource, status: number): string {
  const variable = tokenVariable(source);
  if ((status === 401 || status === 403) && variable !== undefined) {
    return `check ${variable}`;
  }
  return `HTTP ${String(status)}`;
}
