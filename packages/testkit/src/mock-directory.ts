import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One listing a mock directory advertises in its `index.json`. */
export interface MockDirectoryListing {
  readonly description: string;
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

/** One file of a mock skill's content response. */
export interface MockDirectoryFile {
  readonly content: string;
  readonly path: string;
}

/** One request the mock directory served, for asserting what a run sent — and did not send. */
export interface MockDirectoryRequest {
  readonly authorization: string | undefined;
  readonly method: string;
  readonly path: string;
}

/** A running mock skill directory. Dispose it, or `close` it, when the test is done. */
export interface MockDirectory extends AsyncDisposable {
  readonly close: () => Promise<void>;
  readonly requests: readonly MockDirectoryRequest[];
  /** Loopback base URL, ready to be used as a skill directory `url`. */
  readonly url: string;
}

export interface MockDirectoryBuilder {
  /** Serves the listing plus a content response of exactly these files. */
  readonly skill: (
    listing: MockDirectoryListing,
    files: readonly MockDirectoryFile[],
  ) => MockDirectoryBuilder;
  /** Appends a raw entry to a skill's `files` array — hostile paths, symlinks, junk. */
  readonly rawFileEntry: (skillId: string, entry: unknown) => MockDirectoryBuilder;
  /** Replaces a skill's content response with an oversized opaque payload. */
  readonly payloadBytes: (skillId: string, bytes: number) => MockDirectoryBuilder;
  /** Requires `Authorization: Bearer <token>` on every request; anything else gets 401. */
  readonly requireToken: (token: string) => MockDirectoryBuilder;
  readonly build: () => Promise<MockDirectory>;
}

/** A local `node:http` skill directory speaking the standard protocol, one call per scenario. */
export function createMockDirectoryBuilder(): MockDirectoryBuilder {
  const listings: MockDirectoryListing[] = [];
  const files = new Map<string, unknown[]>();
  const payloads = new Map<string, number>();
  let requiredToken: string | undefined;

  const builder: MockDirectoryBuilder = {
    build: () => start(listings, files, payloads, requiredToken),
    payloadBytes: (skillId, bytes) => {
      payloads.set(skillId, bytes);
      return builder;
    },
    rawFileEntry: (skillId, entry) => {
      const existing = files.get(skillId) ?? [];
      existing.push(entry);
      files.set(skillId, existing);
      return builder;
    },
    requireToken: (token) => {
      requiredToken = token;
      return builder;
    },
    skill: (listing, skillFiles) => {
      listings.push(listing);
      const existing = files.get(listing.id) ?? [];
      existing.push(...skillFiles);
      files.set(listing.id, existing);
      return builder;
    },
  };
  return builder;
}

async function start(
  listings: readonly MockDirectoryListing[],
  files: ReadonlyMap<string, readonly unknown[]>,
  payloads: ReadonlyMap<string, number>,
  requiredToken: string | undefined,
): Promise<MockDirectory> {
  const requests: MockDirectoryRequest[] = [];
  const server: Server = createServer((request, response) => {
    requests.push({
      authorization: request.headers.authorization,
      method: request.method ?? "",
      path: request.url ?? "",
    });
    respond(request, response, listings, files, payloads, requiredToken);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const close = (): Promise<void> =>
    new Promise((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });

  return {
    close,
    requests,
    url: `http://127.0.0.1:${String(address.port)}`,
    [Symbol.asyncDispose]: close,
  };
}

function respond(
  request: IncomingMessage,
  response: ServerResponse,
  listings: readonly MockDirectoryListing[],
  files: ReadonlyMap<string, readonly unknown[]>,
  payloads: ReadonlyMap<string, number>,
  requiredToken: string | undefined,
): void {
  if (requiredToken !== undefined && request.headers.authorization !== `Bearer ${requiredToken}`) {
    response.writeHead(401, { "content-type": "text/plain" });
    response.end("unauthorized");
    return;
  }
  const body =
    request.url === "/index.json"
      ? JSON.stringify(listings)
      : skillBody(request.url, listings, files, payloads);
  if (body === undefined) {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(body);
}

/** The content response for a `/skills/<id>` path, or nothing when the path names no skill. */
function skillBody(
  url: string | undefined,
  listings: readonly MockDirectoryListing[],
  files: ReadonlyMap<string, readonly unknown[]>,
  payloads: ReadonlyMap<string, number>,
): string | undefined {
  if (url?.startsWith("/skills/") !== true) {
    return undefined;
  }
  const skillId = url.slice("/skills/".length);
  const payload = payloads.get(skillId);
  if (payload !== undefined) {
    return "x".repeat(payload);
  }
  const listing = listings.find((candidate) => candidate.id === skillId);
  if (listing === undefined) {
    return undefined;
  }
  return JSON.stringify({ ...listing, files: files.get(skillId) ?? [] });
}
