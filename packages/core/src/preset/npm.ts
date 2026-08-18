import type { Environment } from "@tryaura/aura-sdk";
import { valid as validSemver } from "semver";

import { extractPresetJson, MAX_TAR_BYTES, verifyTarballIntegrity } from "./archive.js";

const MAX_NPM_METADATA_BYTES = 1_000_000;
const REGISTRY_ORIGIN = "https://registry.npmjs.org";

/** One fetched preset document, or why the package could not supply one. */
export type NpmPresetResult =
  | { readonly problem: string; readonly status: "invalid" }
  | { readonly status: "ready"; readonly text: string };

interface NpmDistribution {
  readonly integrity?: string | undefined;
  readonly shasum?: string | undefined;
  readonly tarball: string;
}

/**
 * Resolves `npm:<package>@<version>` to its `package/preset.json`, without installing anything.
 *
 * The package is never unpacked to disk and never executed: only one known path inside the
 * archive is read, and only after the bytes match the digest the registry published for them.
 */
// fallow-ignore-next-line complexity -- validates each independent registry and tarball trust boundary.
export async function loadNpmPreset(
  reference: string,
  environment: Environment,
): Promise<NpmPresetResult> {
  const parsed = parseNpmReference(reference);
  if (typeof parsed === "string") {
    return { problem: parsed, status: "invalid" };
  }
  const metadata = await environment.httpGet({
    maxResponseBytes: MAX_NPM_METADATA_BYTES,
    url: `${REGISTRY_ORIGIN}/${encodeURIComponent(parsed.name)}/${parsed.version}`,
  });
  if (metadata.kind === "failure") {
    return {
      problem: `npm preset metadata request failed (${metadata.reason}).`,
      status: "invalid",
    };
  }
  if (metadata.kind !== "response" || metadata.status !== 200) {
    return { problem: "npm preset metadata was unavailable.", status: "invalid" };
  }
  const distribution = npmDistribution(metadata.body);
  if (distribution === undefined) {
    return {
      problem: "npm preset metadata does not contain a tarball on the npm registry.",
      status: "invalid",
    };
  }
  const archive = await environment.httpGet({
    maxResponseBytes: MAX_TAR_BYTES,
    responseType: "bytes",
    url: distribution.tarball,
  });
  if (archive.kind === "failure") {
    return { problem: `npm preset tarball request failed (${archive.reason}).`, status: "invalid" };
  }
  if (archive.kind !== "binary-response" || archive.status !== 200) {
    return { problem: "npm preset tarball was unavailable.", status: "invalid" };
  }
  const mismatch = verifyTarballIntegrity(archive.body, distribution);
  if (mismatch !== undefined) {
    return { problem: mismatch, status: "invalid" };
  }
  const extracted = extractPresetJson(archive.body);
  return extracted.status === "invalid"
    ? { problem: extracted.problem, status: "invalid" }
    : { status: "ready", text: extracted.text };
}

interface NpmReference {
  readonly name: string;
  readonly version: string;
}

function parseNpmReference(reference: string): NpmReference | string {
  const separator = reference.lastIndexOf("@");
  const name = reference.slice(0, separator);
  const version = reference.slice(separator + 1);
  const validName =
    /^[a-z0-9][a-z0-9._-]*$/u.test(name) ||
    /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u.test(name);
  if (separator <= 0 || !validName || validSemver(version) === null) {
    return "npm preset references must use npm:<package>@<exact-version>.";
  }
  return { name, version };
}

/**
 * Reads the distribution block, requiring the tarball to live on the registry that vouched for it.
 *
 * Metadata names its own download location, so without pinning the origin a compromised or
 * substituted registry response could send the fetch anywhere while still looking well-formed.
 */
function npmDistribution(text: string): NpmDistribution | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const dist = isPlainRecord(value) ? value["dist"] : undefined;
  if (!isPlainRecord(dist)) {
    return undefined;
  }
  const tarball = registryTarball(dist["tarball"]);
  if (tarball === undefined) {
    return undefined;
  }
  return {
    ...(typeof dist["integrity"] === "string" ? { integrity: dist["integrity"] } : {}),
    ...(typeof dist["shasum"] === "string" ? { shasum: dist["shasum"] } : {}),
    tarball,
  };
}

function registryTarball(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.origin === REGISTRY_ORIGIN && url.username === "" && url.password === ""
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
