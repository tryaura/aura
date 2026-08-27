import { describe, expect, it } from "vitest";

import { repositoryIdentityFromUrl, sanitizeRepositoryUrl } from "./project-resolve.js";

describe("repository identity", () => {
  it("strips URL credentials before retaining repository metadata", () => {
    expect(
      sanitizeRepositoryUrl("https://user:secret@example.com/acme/api.git?token=other#private"),
    ).toBe("https://example.com/acme/api.git");
    expect(sanitizeRepositoryUrl("git@github.com:acme/api.git")).toBe("github.com:acme/api.git");
  });

  it("keeps same-named repositories under distinct canonical keys", () => {
    const first = repositoryIdentityFromUrl("https://github.com/acme/api.git");
    const second = repositoryIdentityFromUrl("https://github.com/other/api.git");

    expect(first).toEqual({
      key: "remote:github.com/acme/api",
      label: "api",
      qualifiedLabel: "github.com/acme/api",
    });
    expect(second?.key).not.toBe(first?.key);
  });

  it("rejects malformed remote values instead of retaining possible credentials", () => {
    expect(sanitizeRepositoryUrl("https://user:secret@")).toBeUndefined();
    expect(repositoryIdentityFromUrl("not a remote")).toBeUndefined();
  });
});
