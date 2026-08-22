import type { HttpGetRequest, HttpGetResult } from "@tryaura/aura-sdk";

import { resolveGitHubRelease } from "./github-release.js";
import { resolveSignedManifest } from "./signed-manifest.js";
import type { CliUpdates, UpdateCandidate, UpdateTarget } from "./types.js";

/** The bounded, TLS-only, redirect-refusing GET every provider fetches its metadata with. */
export type UpdateHttpGet = (request: HttpGetRequest) => Promise<HttpGetResult>;

/** One release-metadata lookup. Carries no credential — only the name of the variable holding one. */
export interface UpdateQuery {
  /** Distribution command name, which is also the release asset's name prefix. */
  readonly command: string;
  /** Entity tag of the cached metadata, so an unchanged release costs one conditional request. */
  readonly etag?: string | undefined;
  readonly httpGet: UpdateHttpGet;
  /** Wall clock the freshness window of a signed manifest is judged against. */
  readonly now: number;
  /** Reads one variable at the moment of use. The value never outlives the request it authorizes. */
  readonly readVariable: (name: string) => string | undefined;
  readonly target: UpdateTarget;
  readonly userAgent: string;
  /** Version currently installed, which a candidate must be strictly newer than. */
  readonly version: string;
}

/** The outcome of one lookup. */
export type UpdateResolution =
  /** No release is newer than the running one. */
  | { readonly etag?: string | undefined; readonly kind: "current" }
  | {
      readonly candidate: UpdateCandidate;
      /**
       * Headers the archive download must carry, built fresh per lookup.
       *
       * Kept beside the candidate so a credential can never enter persistent update state.
       */
      readonly downloadHeaders: Readonly<Record<string, string>>;
      readonly etag?: string | undefined;
      readonly kind: "candidate";
    }
  | {
      readonly kind: "failure";
      /**
       * Why no candidate came back. Never error text: a message could echo a request header.
       *
       * `network` is a request that did not complete or a status the provider cannot use;
       * `invalid-release` a readable response that does not describe exactly one usable release
       * for this target; `untrusted-release` a signature, immutability, or origin requirement that
       * did not hold; `stale-manifest` a correctly signed manifest outside the window it signed
       * for, which is a publisher mistake rather than an attack and must not read as one.
       */
      readonly reason: "invalid-release" | "network" | "stale-manifest" | "untrusted-release";
    };

/** Turns one distribution-specific source into a validated candidate. */
export function resolveUpdateSource(
  source: CliUpdates,
  query: UpdateQuery,
): Promise<UpdateResolution> {
  return source.kind === "github-release"
    ? resolveGitHubRelease(source, query)
    : resolveSignedManifest(source, query);
}

/**
 * The cache key one source's metadata is stored under.
 *
 * Includes every build-time field that changes lookup or trust and never includes a credential
 * value. The complete manifest URL and trusted keys ensure either change selects a new cache entry.
 */
export function sourceIdentity(source: CliUpdates, command: string): string {
  if (source.kind === "github-release") {
    return JSON.stringify([
      "github-release",
      source.apiBaseUrl ?? "https://api.github.com",
      source.owner,
      source.repository,
      source.tokenEnvironmentVariable ?? "",
      command,
    ]);
  }
  return JSON.stringify([
    "signed-manifest",
    source.manifestUrl,
    source.tokenEnvironmentVariable ?? "",
    source.trustedPublicKeys,
    command,
  ]);
}
