import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import type { HttpGetRequest } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import type { UpdateQuery, UpdateResolution } from "./provider.js";
import { resolveSignedManifest } from "./signed-manifest.js";
import type { CliUpdateSource } from "./types.js";

const DIGEST = "b".repeat(64);
const KEYS = generateKeyPairSync("ed25519");
const OTHER = generateKeyPairSync("ed25519");

describe("signed manifest provider", () => {
  it("accepts a manifest signed by a trusted key", async () => {
    const { resolution } = await resolve();

    expect(resolution).toEqual({
      candidate: {
        archive: {
          downloadUrl: "https://releases.acme.example/acmedev/v1.4.0/acmedev-darwin-arm64.tar.gz",
          sha256: DIGEST,
          size: 12_345,
        },
        version: "1.4.0",
      },
      downloadHeaders: { accept: "application/octet-stream" },
      etag: '"manifest-1"',
      kind: "candidate",
    });
  });

  /**
   * Rotation is the reason more than one key is trusted at a time. The release still signed by the
   * outgoing key is what distributes the binary that trusts its replacement.
   */
  it("accepts either key while one is being rotated out", async () => {
    const { resolution } = await resolve({
      signWith: OTHER.privateKey,
      trusted: [rawPublicKey(KEYS.publicKey), rawPublicKey(OTHER.publicKey)],
    });
    expect(resolution).toMatchObject({ kind: "candidate" });
  });

  it("refuses a payload altered after signing", async () => {
    const { resolution } = await resolve({ tamper: true });
    expect(resolution).toEqual({ kind: "failure", reason: "untrusted-release" });
  });

  it("refuses a manifest signed by a key the distribution does not trust", async () => {
    const { resolution } = await resolve({ signWith: OTHER.privateKey });
    expect(resolution).toEqual({ kind: "failure", reason: "untrusted-release" });
  });

  it.each([
    { envelope: { schemaVersion: 2 }, label: "an unknown schema version" },
    { envelope: { signature: "not base64url!" }, label: "a malformed signature" },
    { envelope: { signature: "AAAA" }, label: "a signature of the wrong length" },
    { envelope: { payload: undefined }, label: "no payload" },
  ])("refuses an envelope with $label", async ({ envelope }) => {
    const { resolution } = await resolve({ envelope });
    expect(resolution).toEqual({ kind: "failure", reason: "untrusted-release" });
  });

  it.each([
    {
      label: "a download URL that is not pinned to the resolved version",
      payload: {
        assets: {
          "darwin-arm64": {
            downloadUrl: "https://releases.acme.example/acmedev/latest/acmedev-darwin-arm64.tar.gz",
            sha256: DIGEST,
            size: 12_345,
          },
        },
      },
    },
    {
      label: "a plaintext download URL",
      payload: {
        assets: {
          "darwin-arm64": {
            downloadUrl: "http://releases.acme.example/acmedev/v1.4.0/acmedev-darwin-arm64.tar.gz",
            sha256: DIGEST,
            size: 12_345,
          },
        },
      },
    },
    { label: "no asset for this target", payload: { assets: {} } },
    { label: "a non-canonical version", payload: { version: "1.4" } },
  ])("refuses a payload with $label", async ({ payload }) => {
    const { resolution } = await resolve({ payload });
    expect(resolution).toEqual({ kind: "failure", reason: "invalid-release" });
  });

  it("reports the running version as current when the manifest names no newer release", async () => {
    const { resolution } = await resolve({ payload: { version: "1.3.0" } });
    expect(resolution).toEqual({ etag: '"manifest-1"', kind: "current" });
  });

  it("carries a configured credential into the request and the download, and nowhere else", async () => {
    const { requests, resolution } = await resolve({
      token: "ACME_MANIFEST_TOKEN",
      variables: { ACME_MANIFEST_TOKEN: "internal-secret" },
    });

    expect(requests[0]?.headers?.["authorization"]).toBe("Bearer internal-secret");
    expect(resolution).toMatchObject({
      downloadHeaders: { authorization: "Bearer internal-secret" },
    });
    const candidate = resolution.kind === "candidate" ? resolution.candidate : undefined;
    expect(JSON.stringify(candidate)).not.toContain("internal-secret");
  });
});

function rawPublicKey(key: KeyObject): string {
  return key.export({ format: "der", type: "spki" }).subarray(12).toString("base64");
}

async function resolve(
  options: {
    readonly envelope?: Readonly<Record<string, unknown>> | undefined;
    readonly payload?: Readonly<Record<string, unknown>> | undefined;
    readonly signWith?: KeyObject | undefined;
    readonly tamper?: boolean | undefined;
    readonly token?: string | undefined;
    readonly trusted?: readonly string[] | undefined;
    readonly variables?: Readonly<Record<string, string>> | undefined;
  } = {},
): Promise<{ requests: HttpGetRequest[]; resolution: UpdateResolution }> {
  const payload = Buffer.from(
    JSON.stringify({
      assets: {
        "darwin-arm64": {
          downloadUrl: "https://releases.acme.example/acmedev/v1.4.0/acmedev-darwin-arm64.tar.gz",
          sha256: DIGEST,
          size: 12_345,
        },
      },
      version: "1.4.0",
      ...options.payload,
    }),
    "utf8",
  );
  const signature = sign(null, payload, options.signWith ?? KEYS.privateKey);
  const body = JSON.stringify({
    payload: (options.tamper === true
      ? Buffer.from(payload.toString("utf8").replace("1.4.0", "9.9.9"), "utf8")
      : payload
    ).toString("base64url"),
    schemaVersion: 1,
    signature: signature.toString("base64url"),
    ...options.envelope,
  });

  const source: Extract<CliUpdateSource, { kind: "signed-manifest" }> = {
    kind: "signed-manifest",
    manifestUrl: "https://releases.acme.example/acmedev/latest.json",
    ...(options.token === undefined ? {} : { tokenEnvironmentVariable: options.token }),
    trustedPublicKeys: options.trusted ?? [rawPublicKey(KEYS.publicKey)],
  };

  const requests: HttpGetRequest[] = [];
  const query: UpdateQuery = {
    command: "acmedev",
    httpGet: (request) => {
      requests.push(request);
      return Promise.resolve({ body, etag: '"manifest-1"', kind: "response", status: 200 });
    },
    readVariable: (name) => options.variables?.[name],
    target: "darwin-arm64",
    userAgent: "acmedev/1.3.0",
    version: "1.3.0",
  };
  return { requests, resolution: await resolveSignedManifest(source, query) };
}
