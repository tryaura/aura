import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { createHttpGet } from "./http.js";

const httpGet = createHttpGet();

async function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
    url: `http://127.0.0.1:${address.port}`,
  };
}

describe("createHttpGet", () => {
  it("refuses a URL that does not parse", async () => {
    await expect(httpGet({ url: "not a url" })).resolves.toEqual({
      kind: "failure",
      reason: "invalid-url",
    });
  });

  it("refuses plain http to a non-loopback host without connecting", async () => {
    await expect(httpGet({ url: "http://example.com/index.json" })).resolves.toEqual({
      kind: "failure",
      reason: "insecure-url",
    });
  });

  it("refuses http to localhost, which can resolve anywhere", async () => {
    await expect(httpGet({ url: "http://localhost:1/index.json" })).resolves.toEqual({
      kind: "failure",
      reason: "insecure-url",
    });
  });

  it("refuses non-http protocols", async () => {
    await expect(httpGet({ url: "ftp://127.0.0.1/index.json" })).resolves.toEqual({
      kind: "failure",
      reason: "insecure-url",
    });
  });

  it("serves loopback http responses with status and body", async () => {
    const server = await listen((request, response) => {
      response.writeHead(request.url === "/found" ? 200 : 404);
      response.end(request.url === "/found" ? "hello" : "missing");
    });
    try {
      await expect(httpGet({ url: `${server.url}/found` })).resolves.toEqual({
        body: "hello",
        kind: "response",
        status: 200,
      });
      await expect(httpGet({ url: `${server.url}/other` })).resolves.toEqual({
        body: "missing",
        kind: "response",
        status: 404,
      });
    } finally {
      await server.close();
    }
  });

  it("sends the request headers verbatim", async () => {
    let seen: string | undefined;
    const server = await listen((request, response) => {
      seen = request.headers.authorization;
      response.end("ok");
    });
    try {
      await httpGet({
        headers: { Authorization: "Bearer sk-fixture-secret" },
        url: `${server.url}/index.json`,
      });
      expect(seen).toBe("Bearer sk-fixture-secret");
    } finally {
      await server.close();
    }
  });

  it("abandons a body that exceeds the byte cap", async () => {
    const server = await listen((_request, response) => {
      response.end("x".repeat(2048));
    });
    try {
      await expect(httpGet({ maxResponseBytes: 1024, url: `${server.url}/big` })).resolves.toEqual({
        kind: "failure",
        reason: "response-too-large",
      });
    } finally {
      await server.close();
    }
  });

  it("refuses redirects rather than re-sending headers to a new address", async () => {
    const server = await listen((_request, response) => {
      response.writeHead(302, { Location: "http://127.0.0.1:9/elsewhere" });
      response.end();
    });
    try {
      await expect(httpGet({ url: `${server.url}/redirect` })).resolves.toEqual({
        kind: "failure",
        reason: "network",
      });
    } finally {
      await server.close();
    }
  });

  it("reports an unreachable server as a network failure", async () => {
    await expect(httpGet({ url: "http://127.0.0.1:9/index.json" })).resolves.toEqual({
      kind: "failure",
      reason: "network",
    });
  });

  it("reports a stalled server as a timeout", async () => {
    const server = await listen(() => {
      // Accept the request and never respond.
    });
    try {
      await expect(httpGet({ timeoutMs: 200, url: `${server.url}/slow` })).resolves.toEqual({
        kind: "failure",
        reason: "timeout",
      });
    } finally {
      await server.close();
    }
  });
});
