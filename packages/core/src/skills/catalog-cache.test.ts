import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HttpGetRequest, HttpGetResult } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { createEnvironment } from "../environment.boundary.js";
import { listDirectorySkills } from "./directory-client.js";
import { LISTING, PUBLIC_SOURCE } from "./directory-client.test-support.js";

interface CacheFixture {
  readonly environment: ReturnType<typeof createEnvironment>;
  readonly requests: HttpGetRequest[];
  readonly setNow: (value: Date) => void;
  readonly setRespond: (value: (request: HttpGetRequest) => HttpGetResult) => void;
}

async function fixture(respond: (request: HttpGetRequest) => HttpGetResult): Promise<CacheFixture> {
  const homeDir = await mkdtemp(join(tmpdir(), "aura-skill-catalog-cache-"));
  let now = new Date("2026-08-18T00:00:00.000Z");
  let responder = respond;
  const requests: HttpGetRequest[] = [];
  const environment = createEnvironment({
    cwd: "/workspace",
    homeDir,
    httpGet: (request) => {
      requests.push(request);
      return Promise.resolve(responder(request));
    },
    now: () => now,
  });
  return {
    environment,
    requests,
    setNow: (value) => {
      now = value;
    },
    setRespond: (value) => {
      responder = value;
    },
  };
}

const INDEX_OK: HttpGetResult = {
  body: JSON.stringify([LISTING]),
  etag: '"v1"',
  kind: "response",
  status: 200,
};

describe("skill catalog cache", () => {
  it("serves a fresh entry with no request and says so", async () => {
    const { environment, requests } = await fixture(() => INDEX_OK);

    expect((await listDirectorySkills(environment, PUBLIC_SOURCE)).listings).toHaveLength(1);
    expect(requests).toHaveLength(1);

    const second = await listDirectorySkills(environment, PUBLIC_SOURCE);
    expect(requests).toHaveLength(1);
    expect(second.listings).toHaveLength(1);
    expect(second.diagnostics[0]?.message).toContain("served from the local cache");
    expect(second.diagnostics[0]?.message).toContain("--no-cache");
  });

  it("revalidates a stale entry with If-None-Match and serves the 304 silently", async () => {
    const { environment, requests, setNow, setRespond } = await fixture(() => INDEX_OK);
    await listDirectorySkills(environment, PUBLIC_SOURCE);

    setNow(new Date("2026-08-18T02:00:00.000Z"));
    setRespond(() => ({ body: "", kind: "response", status: 304 }));
    const result = await listDirectorySkills(environment, PUBLIC_SOURCE);

    expect(requests).toHaveLength(2);
    expect(requests[1]?.headers).toEqual({ "If-None-Match": '"v1"' });
    expect(result.listings).toHaveLength(1);
    expect(result.diagnostics).toEqual([]);

    // The 304 refreshed the entry, so the next run inside the window is served without a request.
    setNow(new Date("2026-08-18T02:30:00.000Z"));
    await listDirectorySkills(environment, PUBLIC_SOURCE);
    expect(requests).toHaveLength(2);
  });

  it("falls back to the stale copy when the source cannot be reached", async () => {
    const { environment, setNow, setRespond } = await fixture(() => INDEX_OK);
    await listDirectorySkills(environment, PUBLIC_SOURCE);

    setNow(new Date("2026-08-18T02:00:00.000Z"));
    setRespond(() => ({ kind: "failure", reason: "network" }));
    const result = await listDirectorySkills(environment, PUBLIC_SOURCE);

    expect(result.status).toEqual({ kind: "available" });
    expect(result.listings).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain("could not be reached");
    expect(result.diagnostics[0]?.message).toContain("served from the local cache (2 h old)");
  });

  it("treats an entry past the stale ceiling as a miss", async () => {
    const { environment, setNow, setRespond } = await fixture(() => INDEX_OK);
    await listDirectorySkills(environment, PUBLIC_SOURCE);

    setNow(new Date("2026-08-26T00:00:01.000Z"));
    setRespond(() => ({ kind: "failure", reason: "network" }));
    const result = await listDirectorySkills(environment, PUBLIC_SOURCE);

    expect(result.status).toEqual({ hint: "unreachable", kind: "unavailable" });
    expect(result.listings).toEqual([]);
  });

  it("bypasses reads and writes under --no-cache", async () => {
    const { environment, requests } = await fixture(() => INDEX_OK);

    await listDirectorySkills(environment, PUBLIC_SOURCE, { noCache: true });
    await listDirectorySkills(environment, PUBLIC_SOURCE, { noCache: true });
    expect(requests).toHaveLength(2);

    // Nothing was written either: a cached-mode run right after still has to fetch.
    await listDirectorySkills(environment, PUBLIC_SOURCE);
    expect(requests).toHaveLength(3);
  });

  it("never caches a private directory listing", async () => {
    const { environment, requests } = await fixture(() => INDEX_OK);
    const source = {
      id: "directory:acme",
      kind: "private-directory",
      name: "Acme Skills",
      tokenEnv: "ACME_SKILLS_TOKEN",
      url: "https://skills.acme.example",
    } as const;
    const withToken = createEnvironment({
      cwd: environment.cwd,
      environmentVariables: { ACME_SKILLS_TOKEN: "secret" },
      homeDir: environment.homeDir,
      httpGet: environment.httpGet,
      now: environment.now,
    });

    await listDirectorySkills(withToken, source);
    await listDirectorySkills(withToken, source);

    expect(requests).toHaveLength(2);
  });
});
