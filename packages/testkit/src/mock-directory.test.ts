import { describe, expect, it } from "vitest";

import { loopbackOnlyHttpGet } from "./http.js";
import { createMockDirectoryBuilder } from "./mock-directory.js";

const LISTING = {
  description: "Review changes before landing.",
  id: "review",
  name: "Review",
  version: "1.0.0",
};

describe("createMockDirectoryBuilder", () => {
  it("serves the index and skill content over loopback", async () => {
    await using directory = await createMockDirectoryBuilder()
      .skill(LISTING, [{ content: "# Review\n", path: "SKILL.md" }])
      .build();

    const index = await loopbackOnlyHttpGet({ url: `${directory.url}/index.json` });
    const content = await loopbackOnlyHttpGet({ url: `${directory.url}/skills/review` });

    expect(index).toEqual({ body: JSON.stringify([LISTING]), kind: "response", status: 200 });
    expect(content.kind).toBe("response");
    if (content.kind === "response") {
      expect(JSON.parse(content.body)).toEqual({
        ...LISTING,
        files: [{ content: "# Review\n", path: "SKILL.md" }],
      });
    }
    expect(directory.requests.map((request) => request.path)).toEqual([
      "/index.json",
      "/skills/review",
    ]);
  });

  it("rejects missing and wrong tokens with 401, recording what was sent", async () => {
    await using directory = await createMockDirectoryBuilder()
      .skill(LISTING, [{ content: "# Review\n", path: "SKILL.md" }])
      .requireToken("sk-fixture-secret")
      .build();

    const missing = await loopbackOnlyHttpGet({ url: `${directory.url}/index.json` });
    const wrong = await loopbackOnlyHttpGet({
      headers: { Authorization: "Bearer sk-wrong" },
      url: `${directory.url}/index.json`,
    });
    const right = await loopbackOnlyHttpGet({
      headers: { Authorization: "Bearer sk-fixture-secret" },
      url: `${directory.url}/index.json`,
    });

    expect(missing.kind === "response" && missing.status).toBe(401);
    expect(wrong.kind === "response" && wrong.status).toBe(401);
    expect(right.kind === "response" && right.status).toBe(200);
    expect(directory.requests.map((request) => request.authorization)).toEqual([
      undefined,
      "Bearer sk-wrong",
      "Bearer sk-fixture-secret",
    ]);
  });

  it("serves raw hostile entries and oversized payloads for guard tests", async () => {
    await using directory = await createMockDirectoryBuilder()
      .skill(LISTING, [{ content: "# Review\n", path: "SKILL.md" }])
      .rawFileEntry("review", { content: "evil", path: "../evil" })
      .skill({ ...LISTING, id: "huge", name: "Huge" }, [])
      .payloadBytes("huge", 2048)
      .build();

    const hostile = await loopbackOnlyHttpGet({ url: `${directory.url}/skills/review` });
    const huge = await loopbackOnlyHttpGet({
      maxResponseBytes: 1024,
      url: `${directory.url}/skills/huge`,
    });

    expect(hostile.kind === "response" && hostile.body).toContain("../evil");
    expect(huge).toEqual({ kind: "failure", reason: "response-too-large" });
  });

  it("keeps test runs on the machine: non-loopback hosts are refused", async () => {
    await expect(
      loopbackOnlyHttpGet({ url: "https://agenticskills.io/index.json" }),
    ).resolves.toEqual({ kind: "failure", reason: "network" });
    await expect(loopbackOnlyHttpGet({ url: "not a url" })).resolves.toEqual({
      kind: "failure",
      reason: "invalid-url",
    });
  });
});
