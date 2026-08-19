/* eslint-disable max-lines -- loader source, cache, and hostile archive cases share one fixture server and tar builder. */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import type { HttpGetRequest } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { createEnvironment } from "../environment.boundary.js";
import { createMemoryReader } from "../workspace/testing.js";
import { loadTeamPreset } from "./load.js";

const DOCUMENT =
  '{"schemaVersion":1,"name":"acme-platform","checks":{"disabled":["INS-007"],"thresholds":{"INS-007":{"approxTokens":12000}}},"scripts":{"postinstall":"exit 99"},"vendor":{"__proto__":{"polluted":true}}}';

describe("loadTeamPreset", () => {
  it("never selects the repository .aura/preset.json, which is its own layer", async () => {
    const environment = createEnvironment({ cwd: "/workspace", homeDir: "/home/dev" });
    const result = await loadTeamPreset({
      environment,
      reader: createMemoryReader({ "/workspace/.aura/preset.json": DOCUMENT }),
    });

    expect(result).toEqual({ status: "missing" });
  });

  it.each(["team.json", "file:///workspace/team.json"])(
    "loads an explicit local reference %s",
    async (reference) => {
      const environment = createEnvironment({ cwd: "/workspace", homeDir: "/home/dev" });
      const result = await loadTeamPreset({
        cliReference: reference,
        environment,
        reader: createMemoryReader({ "/workspace/team.json": DOCUMENT }),
      });

      expect(result).toMatchObject({ preset: { name: "acme-platform" }, status: "ready" });
    },
  );

  it("resolves registered plugin preset JSON without importing the plugin source", async () => {
    const environment = createEnvironment({ cwd: "/workspace", homeDir: "/home/dev" });
    const result = await loadTeamPreset({
      cliReference: "plugin:acme/platform",
      environment,
      presets: [
        {
          description: "Fixture.",
          id: "acme/platform",
          kind: "preset",
          name: "Acme",
          source: { type: "file", url: "file:///plugins/acme/preset.json" },
          version: "1.0.0",
        },
      ],
      reader: createMemoryReader({ "/plugins/acme/preset.json": DOCUMENT }),
    });

    expect(result).toMatchObject({ preset: { name: "acme-platform" }, status: "ready" });
  });

  it.each([
    [{ cliReference: "cli.json", manifestReference: "manifest.json" }, "cli"],
    [{ manifestReference: "manifest.json" }, "manifest"],
    [{}, "default"],
  ])("selects CLI, then manifest references before the distro default", async (refs, name) => {
    const environment = createEnvironment({ cwd: "/workspace", homeDir: "/home/dev" });
    const result = await loadTeamPreset({
      ...refs,
      defaultReference: "default.json",
      environment,
      reader: createMemoryReader({
        "/workspace/.aura/preset.json": namedDocument("implicit"),
        "/workspace/cli.json": namedDocument("cli"),
        "/workspace/default.json": namedDocument("default"),
        "/workspace/manifest.json": namedDocument("manifest"),
      }),
    });

    expect(result).toMatchObject({ preset: { name }, status: "ready" });
  });

  it("loads HTTPS JSON through the bounded injected client", async () => {
    const requests: HttpGetRequest[] = [];
    const environment = createEnvironment({
      cwd: "/workspace",
      homeDir: "/home/dev",
      httpGet: (request) => {
        requests.push(request);
        return Promise.resolve({ body: DOCUMENT, kind: "response", status: 200 });
      },
    });

    const result = await loadTeamPreset({
      cliReference: "https://presets.example/acme.json",
      environment,
      noCache: true,
      reader: createMemoryReader(),
    });

    expect(result.status).toBe("ready");
    expect(requests).toEqual([
      { maxResponseBytes: 256_000, url: "https://presets.example/acme.json" },
    ]);
  });

  it("rejects insecure URL references before making a request", async () => {
    let requests = 0;
    const environment = createEnvironment({
      cwd: "/workspace",
      homeDir: "/home/dev",
      httpGet: () => {
        requests += 1;
        return Promise.resolve({ body: DOCUMENT, kind: "response", status: 200 });
      },
    });

    const result = await loadTeamPreset({
      cliReference: "http://presets.example/acme.json",
      environment,
      noCache: true,
      reader: createMemoryReader(),
    });

    expect(result).toMatchObject({
      message: "Preset URL references must use HTTPS.",
      status: "invalid",
    });
    expect(requests).toBe(0);
  });

  it("rejects URL credentials without echoing them", async () => {
    const result = await loadTeamPreset({
      cliReference: "https://secret-user:secret-password@presets.example/acme.json",
      environment: createEnvironment({ cwd: "/workspace", homeDir: "/home/dev" }),
      noCache: true,
      reader: createMemoryReader(),
    });

    expect(result).toMatchObject({ status: "invalid" });
    expect(JSON.stringify(result)).not.toContain("secret-user");
    expect(JSON.stringify(result)).not.toContain("secret-password");
  });

  it("extracts only package/preset.json from an exact-version npm tarball", async () => {
    const tarball = npmTarball(DOCUMENT);
    const environment = createEnvironment({
      cwd: "/workspace",
      homeDir: "/home/dev",
      httpGet: (request) => {
        if (request.responseType === "bytes") {
          return Promise.resolve({ body: tarball, kind: "binary-response", status: 200 });
        }
        return Promise.resolve({
          body: JSON.stringify({
            dist: {
              integrity: npmIntegrity(tarball),
              tarball: "https://registry.npmjs.org/acme/-/acme-1.0.0.tgz",
            },
          }),
          kind: "response",
          status: 200,
        });
      },
    });

    const result = await loadTeamPreset({
      cliReference: "npm:@acme/preset@1.0.0",
      environment,
      noCache: true,
      reader: createMemoryReader(),
    });

    expect(result).toMatchObject({ preset: { name: "acme-platform" }, status: "ready" });
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it.each([
    [npmTarball(DOCUMENT, "../preset.json"), "unsafe entry path"],
    [npmTarball(DOCUMENT, "package/preset.json", 50), "link entry"],
    [
      npmTarballEntries([
        { content: DOCUMENT, name: "package/preset.json", type: 48 },
        { content: DOCUMENT, name: "package/preset.json", type: 48 },
      ]),
      "duplicate entry path",
    ],
  ])("rejects unsafe npm archive structures", async (tarball, message) => {
    const environment = npmEnvironment(tarball);
    const result = await loadTeamPreset({
      cliReference: "npm:@acme/preset@1.0.0",
      environment,
      noCache: true,
      reader: createMemoryReader(),
    });

    expect(result).toMatchObject({ status: "invalid" });
    if (result.status === "invalid") {
      expect(result.message).toContain(message);
    }
  });

  it("refuses a tarball whose bytes do not match the published digest", async () => {
    const environment = npmEnvironment(npmTarball(DOCUMENT), npmIntegrity(npmTarball("{}")));

    const result = await loadTeamPreset({
      cliReference: "npm:@acme/preset@1.0.0",
      environment,
      noCache: true,
      reader: createMemoryReader(),
    });

    expect(result).toMatchObject({ status: "invalid" });
    if (result.status === "invalid") {
      expect(result.message).toContain("does not match the integrity digest");
    }
  });

  it("refuses a package that publishes no digest at all", async () => {
    const environment = npmEnvironment(npmTarball(DOCUMENT), null);

    const result = await loadTeamPreset({
      cliReference: "npm:@acme/preset@1.0.0",
      environment,
      noCache: true,
      reader: createMemoryReader(),
    });

    expect(result).toMatchObject({ status: "invalid" });
    if (result.status === "invalid") {
      expect(result.message).toContain("integrity digest");
    }
  });

  it("refuses a tarball hosted away from the registry that resolved it", async () => {
    const tarball = npmTarball(DOCUMENT);
    const environment = createEnvironment({
      cwd: "/workspace",
      homeDir: "/home/dev",
      httpGet: (request) =>
        Promise.resolve(
          request.responseType === "bytes"
            ? { body: tarball, kind: "binary-response", status: 200 }
            : {
                body: JSON.stringify({
                  dist: {
                    integrity: npmIntegrity(tarball),
                    tarball: "https://cdn.example.test/acme-1.0.0.tgz",
                  },
                }),
                kind: "response",
                status: 200,
              },
        ),
    });

    const result = await loadTeamPreset({
      cliReference: "npm:@acme/preset@1.0.0",
      environment,
      noCache: true,
      reader: createMemoryReader(),
    });

    expect(result).toMatchObject({ status: "invalid" });
    if (result.status === "invalid") {
      expect(result.message).toContain("tarball on the npm registry");
    }
  });

  it("refuses to fetch an uncached remote reference when the run is offline", async () => {
    let requests = 0;
    const environment = createEnvironment({
      cwd: "/workspace",
      homeDir: await mkdtemp(join(tmpdir(), "aura-preset-offline-")),
      httpGet: () => {
        requests += 1;
        return Promise.resolve({ body: DOCUMENT, kind: "response", status: 200 } as const);
      },
    });

    const result = await loadTeamPreset({
      cliReference: "https://presets.example/acme.json",
      environment,
      offline: true,
      reader: createMemoryReader(),
    });

    expect(result).toMatchObject({ status: "invalid" });
    if (result.status === "invalid") {
      expect(result.message).toContain("offline");
    }
    expect(requests).toBe(0);
  });

  it("uses fresh cache entries but fails closed after expiry", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "aura-preset-cache-"));
    let now = new Date("2026-08-18T00:00:00.000Z");
    let online = true;
    let requests = 0;
    const environment = createEnvironment({
      cwd: "/workspace",
      homeDir,
      httpGet: () => {
        requests += 1;
        return Promise.resolve(
          online
            ? { body: DOCUMENT, kind: "response", status: 200 }
            : { kind: "failure", reason: "network" },
        );
      },
      now: () => now,
    });
    const options = {
      cliReference: "https://presets.example/acme.json",
      environment,
      reader: createMemoryReader(),
    };

    expect((await loadTeamPreset(options)).status).toBe("ready");
    online = false;
    expect((await loadTeamPreset(options)).status).toBe("ready");
    expect(requests).toBe(1);

    now = new Date("2026-08-19T00:00:01.000Z");
    expect((await loadTeamPreset(options)).status).toBe("invalid");
    expect(requests).toBe(2);
  });
});

function npmTarball(content: string, name = "package/preset.json", type = 48): Uint8Array {
  return npmTarballEntries([{ content, name, type }]);
}

function namedDocument(name: string): string {
  return JSON.stringify({ name, schemaVersion: 1 });
}

function npmTarballEntries(
  entries: readonly { readonly content: string; readonly name: string; readonly type: number }[],
): Uint8Array {
  const blocks = entries.flatMap(({ content, name, type }) => {
    const body = Buffer.from(content, "utf8");
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, body.length);
    writeOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = type;
    header.write("ustar", 257, "utf8");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeOctal(header, 148, 8, checksum);
    const padding = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length);
    return [header, body, padding];
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1_024)]));
}

/** The digest npm publishes for a tarball, so a fixture is as verifiable as a real package. */
function npmIntegrity(tarball: Uint8Array): string {
  return `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
}

function npmEnvironment(tarball: Uint8Array, integrity?: string | null) {
  return createEnvironment({
    cwd: "/workspace",
    homeDir: "/home/dev",
    httpGet: (request) =>
      Promise.resolve(
        request.responseType === "bytes"
          ? { body: tarball, kind: "binary-response", status: 200 }
          : {
              body: JSON.stringify({
                dist: {
                  ...(integrity === null ? {} : { integrity: integrity ?? npmIntegrity(tarball) }),
                  tarball: "https://registry.npmjs.org/acme/-/acme-1.0.0.tgz",
                },
              }),
              kind: "response",
              status: 200,
            },
      ),
  });
}

function writeOctal(buffer: Buffer, offset: number, width: number, value: number): void {
  const text = value.toString(8).padStart(width - 2, "0");
  buffer.write(`${text}\0 `, offset, width, "ascii");
}
