import type { HttpGetRequest, HttpGetResult } from "@tryaura/aura-sdk";

import { resolveGitHubRelease } from "./github-release.js";
import { resolveSignedManifest } from "./signed-manifest.js";
import type { CliUpdateCandidate, CliUpdateSource, CliUpdateTarget } from "./types.js";

/** The bounded, TLS-only, redirect-refusing GET every provider fetches its metadata with. */
export type UpdateHttpGet = (request: HttpGetRequest) => Promise<HttpGetResult>;

/** One release-metadata lookup. Carries no credential — only the name of the variable holding one. */
export interface UpdateQuery {
  /** Distribution command name, which is also the release asset's name prefix. */
  readonly command: string;
  /** Entity tag of the cached metadata, so an unchanged release costs one conditional request. */
  readonly etag?: string | undefined;
  readonly httpGet: UpdateHttpGet;
  /** Reads one variable at the moment of use. The value never outlives the request it authorizes. */
  readonly readVariable: (name: string) => string | undefined;
  readonly target: CliUpdateTarget;
  readonly userAgent: string;
  /** Version currently installed, which a candidate must be strictly newer than. */
  readonly version: string;
}

/** The outcome of one lookup. */
export type UpdateResolution =
  /** No release is newer than the running one. */
  | { readonly etag?: string | undefined; readonly kind: "current" }
  /** The server confirmed the cached metadata is still current. */
  | { readonly kind: "unchanged" }
  | {
      readonly candidate: CliUpdateCandidate;
      /**
       * Headers the archive download must carry, built fresh per lookup.
       *
       * Kept out of {@link CliUpdateCandidate} on purpose: the candidate is the value that gets
       * cached, and a credential must never reach the cache.
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
       * did not hold.
       */
      readonly reason: "invalid-release" | "network" | "untrusted-release";
    };

/** Turns one distribution-specific source into a validated candidate. */
export function resolveUpdateSource(
  source: CliUpdateSource,
  query: UpdateQuery,
): Promise<UpdateResolution> {
  return source.kind === "github-release"
    ? resolveGitHubRelease(source, query)
    : resolveSignedManifest(source, query);
}

/**
 * The cache key one source's metadata is stored under.
 *
 * Includes everything that changes what a lookup means and nothing that authorizes it: pointing a
 * distribution at a different repository is a different entry, while rotating its token is not.
 */
export function sourceIdentity(source: CliUpdateSource, command: string): string {
  if (source.kind === "github-release") {
    return [
      "github-release",
      normalizeOrigin(source.apiBaseUrl),
      source.owner,
      source.repository,
      command,
    ].join("|");
  }
  return ["signed-manifest", normalizeOrigin(source.manifestUrl), command].join("|");
}

/**
 * A URL reduced to origin and path, with any embedded credential dropped.
 *
 * A `https://user:token@host/` base would otherwise put a secret in a cache key, which is a file
 * on disk that outlives the run that wrote it.
 */
function normalizeOrigin(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return raw;
  }
}
