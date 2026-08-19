import { describe, expect, it } from "vitest";

import { createTestEnvironment } from "../workspace/testing.js";
import { treeHash } from "../workspace/skill-tree-walk.js";
import { listDirectorySkills, resolveDirectorySkills } from "./directory-client.js";
import {
  LISTING,
  okDirectoryResponse as ok,
  PACK,
  PRIVATE_SOURCE,
  PUBLIC_SOURCE,
  scriptedDirectoryEnvironment as scripted,
  TOKEN,
} from "./directory-client.test-support.js";

describe("listDirectorySkills", () => {
  it("lists a public directory and attaches the source", async () => {
    const { environment, requests } = scripted(() => ok([LISTING]));

    const result = await listDirectorySkills(environment, PUBLIC_SOURCE);

    expect(result.status).toEqual({ kind: "available" });
    expect(result.diagnostics).toEqual([]);
    expect(result.listings).toEqual([{ ...LISTING, source: PUBLIC_SOURCE }]);
    expect(requests[0]?.url).toBe("https://agenticskills.io/index.json");
    expect(requests[0]?.headers).toEqual({});
  });

  it("resolves protocol paths below a directory URL pathname", async () => {
    const { environment, requests } = scripted(() => ok([LISTING]));

    await listDirectorySkills(environment, {
      ...PUBLIC_SOURCE,
      url: "https://agenticskills.io/api/v1",
    });

    expect(requests[0]?.url).toBe("https://agenticskills.io/api/v1/index.json");
  });

  it("sends the private token as a bearer header read at request time", async () => {
    const { environment, requests } = scripted(() => ok([LISTING]), {
      ACME_SKILLS_TOKEN: TOKEN,
    });

    await listDirectorySkills(environment, PRIVATE_SOURCE);

    expect(requests[0]?.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(requests[0]?.url).toBe("https://skills.acme.example/index.json");
  });

  it("lists a source with a missing token as unavailable without any request", async () => {
    const { environment, requests } = scripted(() => ok([LISTING]));

    const result = await listDirectorySkills(environment, PRIVATE_SOURCE);

    expect(result.status).toEqual({ hint: "set ACME_SKILLS_TOKEN", kind: "unavailable" });
    expect(result.diagnostics).toEqual([]);
    expect(result.listings).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it("names the token variable, never its value, on a 401", async () => {
    const { environment } = scripted(() => ({ body: "denied", kind: "response", status: 401 }), {
      ACME_SKILLS_TOKEN: TOKEN,
    });

    const result = await listDirectorySkills(environment, PRIVATE_SOURCE);

    expect(result.status).toEqual({ hint: "check ACME_SKILLS_TOKEN", kind: "unavailable" });
    expect(result.diagnostics[0]?.message).toBe(
      'Skill source "directory:acme" rejected the token from ACME_SKILLS_TOKEN, so it is unavailable.',
    );
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("retries a transient failure exactly once", async () => {
    const { environment, requests } = scripted((_request, call) =>
      call === 1 ? { kind: "failure", reason: "network" } : ok([LISTING]),
    );

    const result = await listDirectorySkills(environment, PUBLIC_SOURCE);

    expect(result.listings).toHaveLength(1);
    expect(requests).toHaveLength(2);
  });

  it("gives up after the second transient failure", async () => {
    const { environment, requests } = scripted(() => ({ kind: "failure", reason: "timeout" }));

    const result = await listDirectorySkills(environment, PUBLIC_SOURCE);

    expect(requests).toHaveLength(2);
    expect(result.status).toEqual({ hint: "timed out", kind: "unavailable" });
    expect(result.diagnostics[0]?.message).toBe(
      'Skill source "directory:agenticskills" did not respond in time, so it is unavailable.',
    );
  });

  it("does not retry a definitive failure", async () => {
    const { environment, requests } = scripted(() => ({
      kind: "failure",
      reason: "response-too-large",
    }));

    const result = await listDirectorySkills(environment, PUBLIC_SOURCE);

    expect(requests).toHaveLength(1);
    expect(result.status).toEqual({ hint: "index too large", kind: "unavailable" });
  });

  it("drops malformed index entries without hiding the rest", async () => {
    const { environment } = scripted(() =>
      ok([LISTING, { id: "../evil" }, { ...LISTING, id: "review" }]),
    );

    const result = await listDirectorySkills(environment, PUBLIC_SOURCE);

    expect(result.listings.map((listing) => listing.id)).toEqual(["review"]);
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics[1]?.message).toContain("repeats an earlier ID");
  });
});

describe("resolveDirectorySkills", () => {
  it("resolves a pack with its tree hash and source", async () => {
    const { environment, requests } = scripted(() => ok(PACK), { ACME_SKILLS_TOKEN: TOKEN });

    const result = await resolveDirectorySkills(environment, PRIVATE_SOURCE, ["review"]);

    expect(result.diagnostics).toEqual([]);
    expect(result.skills).toEqual([
      {
        ...LISTING,
        files: PACK.files,
        source: PRIVATE_SOURCE,
        treeHash: treeHash(PACK.files),
      },
    ]);
    expect(requests[0]?.url).toBe("https://skills.acme.example/skills/review");
  });

  it("refuses a pack whose ID differs from the request", async () => {
    const { environment } = scripted(() => ok({ ...PACK, id: "other" }));

    const result = await resolveDirectorySkills(environment, PUBLIC_SOURCE, ["review"]);

    expect(result.skills).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain("describes a different skill ID");
  });

  it.each([
    [[{ content: "x", path: "../evil" }], "path contains an empty, dot, or dot-dot component"],
    [[{ content: "x", path: "/etc/evil" }], "path is absolute"],
    [[{ content: "x", path: "C:\\evil" }], "path contains a backslash"],
    [[{ content: "x", path: "docs/../evil" }], "path contains an empty, dot, or dot-dot component"],
    [[{ content: "x", path: "SKILL.md::$DATA" }], "reserved by Windows"],
    [[{ content: "x", path: "docs/line\nbreak" }], "control character"],
    [[{ content: "x", path: "NUL.txt" }], "device name reserved by Windows"],
    [[{ content: "x", path: "docs/trailing." }], "ending in a dot or space"],
  ])("refuses a pack with a hostile path %j", async (files, fragment) => {
    const { environment } = scripted(() => ok({ ...PACK, files: [...PACK.files, ...files] }));

    const result = await resolveDirectorySkills(environment, PUBLIC_SOURCE, ["review"]);

    expect(result.skills).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain(fragment);
    expect(JSON.stringify(result.diagnostics)).not.toContain("evil");
  });

  it("refuses paths that differ only by portable case", async () => {
    const { environment } = scripted(() =>
      ok({ ...PACK, files: [...PACK.files, { content: "other", path: "skill.md" }] }),
    );

    const result = await resolveDirectorySkills(environment, PUBLIC_SOURCE, ["review"]);

    expect(result.skills).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain("repeats or aliases an earlier path");
  });

  it("bounds concurrent skill-content requests", async () => {
    let active = 0;
    let maximum = 0;
    const environment = createTestEnvironment({
      httpGet: (request) => {
        active += 1;
        maximum = Math.max(maximum, active);
        const id = request.url.slice(request.url.lastIndexOf("/") + 1);
        return new Promise((resolve) => {
          queueMicrotask(() => {
            active -= 1;
            resolve(
              ok({
                description: id,
                files: [{ content: "# Skill\n", path: "SKILL.md" }],
                id,
                name: id,
                version: "1.0.0",
              }),
            );
          });
        });
      },
    });
    const ids = Array.from({ length: 20 }, (_, index) => `skill-${String(index)}`);

    const result = await resolveDirectorySkills(environment, PUBLIC_SOURCE, ids);

    expect(result.skills).toHaveLength(20);
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(8);
  });

  it("skips symlink entries without following them", async () => {
    const { environment } = scripted(() =>
      ok({ ...PACK, files: [...PACK.files, { path: "link", symlink: true }] }),
    );

    const result = await resolveDirectorySkills(environment, PUBLIC_SOURCE, ["review"]);

    expect(result.skills[0]?.files.map((file) => file.path)).toEqual(["SKILL.md"]);
  });

  it("refuses an oversized file with the limit named", async () => {
    const { environment } = scripted(() =>
      ok({
        ...PACK,
        files: [...PACK.files, { content: "x".repeat(1_000_001), path: "big.md" }],
      }),
    );

    const result = await resolveDirectorySkills(environment, PUBLIC_SOURCE, ["review"]);

    expect(result.skills).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain("larger than the 1000000 byte limit");
  });

  it("requires a root SKILL.md", async () => {
    const { environment } = scripted(() =>
      ok({ ...PACK, files: [{ content: "x", path: "docs/notes.md" }] }),
    );

    const result = await resolveDirectorySkills(environment, PUBLIC_SOURCE, ["review"]);

    expect(result.diagnostics[0]?.message).toContain("does not contain a root SKILL.md");
  });

  it("fails one skill without hiding the other", async () => {
    const { environment } = scripted((request) =>
      request.url.endsWith("/skills/review") ? ok(PACK) : ok({ broken: true }),
    );

    const result = await resolveDirectorySkills(environment, PUBLIC_SOURCE, ["review", "other"]);

    expect(result.skills.map((skill) => skill.id)).toEqual(["review"]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain('Skill "other"');
  });

  it("never quotes a hostile requested ID", async () => {
    const { environment, requests } = scripted(() => ok(PACK));

    const result = await resolveDirectorySkills(environment, PUBLIC_SOURCE, ["../EVIL"]);

    expect(requests).toHaveLength(0);
    expect(result.diagnostics[0]?.message).not.toContain("EVIL");
  });

  it("keeps the token value out of every diagnostic", async () => {
    const { environment } = scripted(() => ({ body: "denied", kind: "response", status: 403 }), {
      ACME_SKILLS_TOKEN: TOKEN,
    });

    const listResult = await listDirectorySkills(environment, PRIVATE_SOURCE);
    const resolveResult = await resolveDirectorySkills(environment, PRIVATE_SOURCE, ["review"]);

    expect(JSON.stringify([listResult, resolveResult])).not.toContain(TOKEN);
  });
});
