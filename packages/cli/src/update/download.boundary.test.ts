import { createHash } from "node:crypto";
import { readFile, mkdtemp } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { createUpdateDownload } from "./download.boundary.js";
import type { UpdateDownloadResult } from "./host.js";

const PAYLOAD = "compiled-executable-bytes";
const DIGEST = createHash("sha256").update(PAYLOAD).digest("hex");

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => close(server)));
});

describe("archive download", () => {
  it("streams a body to disk and reports its digest", async () => {
    const origin = await serve((_request, response) => {
      response.writeHead(200, { "content-length": String(PAYLOAD.length) });
      response.end(PAYLOAD);
    });
    const destination = await scratchPath();

    const result = await download(`${origin}/archive.tar.gz`, destination);

    expect(result).toEqual({ kind: "downloaded", sha256: DIGEST });
    expect(await readFile(destination, "utf8")).toBe(PAYLOAD);
  });

  it("refuses a URL that is neither HTTPS nor a literal loopback host", async () => {
    const result = await download(
      "http://releases.acme.example/archive.tar.gz",
      await scratchPath(),
    );
    expect(result).toEqual({ kind: "failure", reason: "insecure-url" });
  });

  it("follows a redirect to the bytes", async () => {
    const target = await serve((_request, response) => response.end(PAYLOAD));
    const origin = await serve((_request, response) => {
      response.writeHead(302, { location: `${target}/archive.tar.gz` });
      response.end();
    });

    expect(await download(`${origin}/assets/12`, await scratchPath())).toEqual({
      kind: "downloaded",
      sha256: DIGEST,
    });
  });

  it("gives up on a redirect loop rather than following it forever", async () => {
    const origin = await serve((request, response) => {
      response.writeHead(302, { location: `/hop${request.url ?? ""}` });
      response.end();
    });

    expect(await download(`${origin}/assets/12`, await scratchPath())).toEqual({
      kind: "failure",
      reason: "network",
    });
  });

  /**
   * GitHub answers an authenticated asset request with a redirect to a signed storage URL that
   * needs no credential of its own. Forwarding one there hands a repository token to a host the
   * caller never named.
   */
  it("drops the credential when a redirect crosses origins", async () => {
    const seen: (string | undefined)[] = [];
    const storage = await serve((request, response) => {
      seen.push(request.headers.authorization);
      response.end(PAYLOAD);
    });
    const api = await serve((request, response) => {
      seen.push(request.headers.authorization);
      response.writeHead(302, { location: `${storage}/signed` });
      response.end();
    });

    await download(`${api}/assets/12`, await scratchPath(), { authorization: "Bearer secret" });

    expect(seen).toEqual(["Bearer secret", undefined]);
  });

  it("keeps the credential across a same-origin redirect", async () => {
    const seen: (string | undefined)[] = [];
    const origin = await serve((request, response) => {
      seen.push(request.headers.authorization);
      if (request.url === "/assets/12") {
        response.writeHead(302, { location: "/bytes" });
        response.end();
        return;
      }
      response.end(PAYLOAD);
    });

    await download(`${origin}/assets/12`, await scratchPath(), { authorization: "Bearer secret" });

    expect(seen).toEqual(["Bearer secret", "Bearer secret"]);
  });

  // Chunked on purpose: without a declared length the only bound left is the byte counter, which
  // is what has to stop a server that streams more than the release said it would.
  it("refuses an undeclared body longer than the release said", async () => {
    const origin = await serve((_request, response) => {
      response.writeHead(200, { "transfer-encoding": "chunked" });
      response.write(PAYLOAD);
      response.end("extra");
    });
    expect(await download(`${origin}/archive`, await scratchPath())).toEqual({
      kind: "failure",
      reason: "too-large",
    });
  });

  it("refuses a body shorter than the release declared", async () => {
    const origin = await serve((_request, response) => response.end("short"));
    expect(await download(`${origin}/archive`, await scratchPath())).toEqual({
      kind: "failure",
      reason: "unexpected-length",
    });
  });

  it("refuses a body whose announced length disagrees with the release", async () => {
    const origin = await serve((_request, response) => {
      response.writeHead(200, { "content-length": "9" });
      response.end("123456789");
    });
    expect(await download(`${origin}/archive`, await scratchPath())).toEqual({
      kind: "failure",
      reason: "unexpected-length",
    });
  });

  /**
   * An enterprise proxy that applies its own `Content-Encoding` leaves `content-length` describing
   * the compressed form while `fetch` hands over the decoded one. Comparing the two would fail a
   * download that is perfectly good, on every attempt, for everyone behind that proxy.
   */
  it("ignores a content-length the transfer encoding has already invalidated", async () => {
    const origin = await serve((_request, response) => {
      response.writeHead(200, {
        "content-encoding": "gzip",
        "content-length": String(gzipSync(PAYLOAD).byteLength),
      });
      response.end(gzipSync(PAYLOAD));
    });

    expect(await download(`${origin}/archive.tar.gz`, await scratchPath())).toEqual({
      kind: "downloaded",
      sha256: DIGEST,
    });
  });

  it("reports progress across the transfer without exceeding the declared length", async () => {
    const origin = await serve((_request, response) => {
      response.writeHead(200, { "content-length": String(PAYLOAD.length) });
      response.end(PAYLOAD);
    });
    const seen: number[] = [];

    await createUpdateDownload()({
      destinationPath: await scratchPath(),
      expectedBytes: PAYLOAD.length,
      headers: {},
      onProgress: (received, total) => seen.push(received / total),
      url: `${origin}/archive.tar.gz`,
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeLessThanOrEqual(1);
  });

  it("refuses a status that is not a redirect and not a body", async () => {
    const origin = await serve((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    expect(await download(`${origin}/archive`, await scratchPath())).toEqual({
      kind: "failure",
      reason: "network",
    });
  });
});

function download(
  url: string,
  destinationPath: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<UpdateDownloadResult> {
  return createUpdateDownload()({
    destinationPath,
    expectedBytes: PAYLOAD.length,
    headers,
    url,
  });
}

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : "";
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

async function scratchPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "aura-update-download-")), "archive.tar.gz");
}
