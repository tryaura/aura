import { createServer, type Server } from "node:http";

import { describe, expect, it } from "vitest";

import { createHttpPost } from "./http-post.boundary.js";

const httpPost = createHttpPost();

async function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fixture server did not expose a TCP address.");
  }
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
    url: `http://127.0.0.1:${address.port}`,
  };
}

describe("createHttpPost", () => {
  it("refuses a URL that does not parse", async () => {
    await expect(httpPost({ body: "{}", url: "not a url" })).resolves.toEqual({
      kind: "failure",
      reason: "invalid-url",
    });
  });

  it("refuses plain http to a non-loopback host without connecting", async () => {
    await expect(httpPost({ body: "{}", url: "http://example.com/events" })).resolves.toEqual({
      kind: "failure",
      reason: "insecure-url",
    });
  });

  it("refuses http to localhost, which can resolve anywhere", async () => {
    await expect(httpPost({ body: "{}", url: "http://localhost:1/events" })).resolves.toEqual({
      kind: "failure",
      reason: "insecure-url",
    });
  });

  it("delivers the body as JSON and reports the status without the response body", async () => {
    let seenBody = "";
    let seenContentType: string | undefined;
    const server = await listen((request, response) => {
      seenContentType = request.headers["content-type"];
      request.on("data", (chunk: Buffer) => {
        seenBody += chunk.toString("utf8");
      });
      request.on("end", () => {
        response.writeHead(202);
        response.end("accepted, with a body the client must not surface");
      });
    });
    try {
      await expect(
        httpPost({ body: '{"events":[]}', url: `${server.url}/events` }),
      ).resolves.toEqual({ kind: "response", status: 202 });
      expect(seenBody).toBe('{"events":[]}');
      expect(seenContentType).toBe("application/json");
    } finally {
      await server.close();
    }
  });

  it("sends caller authentication while enforcing the JSON content type", async () => {
    let seenAuthorization: string | undefined;
    let seenContentType: string | undefined;
    const server = await listen((request, response) => {
      seenAuthorization = request.headers.authorization;
      seenContentType = request.headers["content-type"];
      response.end();
    });
    try {
      await httpPost({
        body: "{}",
        headers: { Authorization: "Bearer sk-fixture-secret", "Content-Type": "text/plain" },
        url: `${server.url}/events`,
      });
      expect(seenAuthorization).toBe("Bearer sk-fixture-secret");
      expect(seenContentType).toBe("application/json");
    } finally {
      await server.close();
    }
  });

  it("reports a non-2xx status as a response, not a failure", async () => {
    const server = await listen((_request, response) => {
      response.writeHead(503);
      response.end();
    });
    try {
      await expect(httpPost({ body: "{}", url: `${server.url}/events` })).resolves.toEqual({
        kind: "response",
        status: 503,
      });
    } finally {
      await server.close();
    }
  });

  it("refuses redirects rather than re-sending headers to a new address", async () => {
    const server = await listen((_request, response) => {
      response.writeHead(307, { Location: "http://127.0.0.1:9/elsewhere" });
      response.end();
    });
    try {
      await expect(httpPost({ body: "{}", url: `${server.url}/events` })).resolves.toEqual({
        kind: "failure",
        reason: "network",
      });
    } finally {
      await server.close();
    }
  });

  it("reports an unreachable server as a network failure", async () => {
    await expect(httpPost({ body: "{}", url: "http://127.0.0.1:9/events" })).resolves.toEqual({
      kind: "failure",
      reason: "network",
    });
  });

  it("reports a stalled server as a timeout", async () => {
    const server = await listen(() => {
      // Accept the request and never respond.
    });
    try {
      await expect(
        httpPost({ body: "{}", timeoutMs: 200, url: `${server.url}/events` }),
      ).resolves.toEqual({ kind: "failure", reason: "timeout" });
    } finally {
      await server.close();
    }
  });

  it("honors caller cancellation before the transport timeout", async () => {
    const server = await listen(() => {
      // Accept the request and never respond unless the caller cancels it.
    });
    const controller = new AbortController();
    try {
      const result = httpPost({
        body: "{}",
        signal: controller.signal,
        timeoutMs: 60_000,
        url: `${server.url}/events`,
      });
      controller.abort();

      await expect(result).resolves.toEqual({ kind: "failure", reason: "timeout" });
    } finally {
      await server.close();
    }
  });
});
