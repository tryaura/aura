import { asRecord, asText, parseJson } from "./narrow.js";
import {
  bearer,
  compareRelease,
  downloadHeaders,
  etagField,
  fetchMetadata,
  sourceToken,
} from "./metadata.js";
import { manifestAsset, verifyEnvelope } from "./signed-envelope.js";
import type { UpdateQuery, UpdateResolution } from "./provider.js";
import type { CliUpdateSource } from "./types.js";

type ManifestSource = Extract<CliUpdateSource, { kind: "signed-manifest" }>;

/**
 * Resolves a release from one signed HTTPS manifest.
 *
 * For deployments a GitHub-shaped provider cannot serve honestly — an internal artifact service, or
 * a GitHub Enterprise Server without immutable releases and per-asset digests. The trust boundary
 * moves from the transport to the signature, so the manifest URL itself may be a stable "latest"
 * reference while every asset URL inside it stays pinned to the version it names.
 */
export async function resolveSignedManifest(
  source: ManifestSource,
  query: UpdateQuery,
): Promise<UpdateResolution> {
  const token = sourceToken(query, source.tokenEnvironmentVariable);
  const response = await fetchMetadata(query, {
    accept: "application/json",
    headers: bearer(token),
    url: source.manifestUrl,
  });

  if (response.kind !== "body") {
    return response.kind === "unchanged"
      ? { kind: "unchanged" }
      : { kind: "failure", reason: "network" };
  }
  return narrowManifest(source, query, response.body, response.etag, token);
}

function narrowManifest(
  source: ManifestSource,
  query: UpdateQuery,
  body: string,
  etag: string | undefined,
  token: string | undefined,
): UpdateResolution {
  const payload = verifyEnvelope(parseJson(body), source.trustedPublicKeys);
  if (payload === undefined) {
    return { kind: "failure", reason: "untrusted-release" };
  }
  const document = asRecord(parseJson(payload));
  const verdict = compareRelease(asText(document?.["version"]), query.version);
  if (verdict.kind !== "newer") {
    return verdict.kind === "current"
      ? { kind: "current", ...etagField(etag) }
      : { kind: "failure", reason: "invalid-release" };
  }

  const archive = manifestAsset(document?.["assets"], query.target, verdict.version);
  return archive === undefined
    ? { kind: "failure", reason: "invalid-release" }
    : {
        candidate: { archive, version: verdict.version },
        downloadHeaders: downloadHeaders(token),
        kind: "candidate",
        ...etagField(etag),
      };
}
