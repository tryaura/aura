import { describe, expect, it } from "vitest";

import { matchRoot, type AllowedRoot } from "./roots.js";

describe("matchRoot", () => {
  const roots: readonly AllowedRoot[] = [
    { exact: false, path: "/Users/Developer/Workspace" },
    { exact: true, path: "/Users/Developer/Config.json" },
  ];

  it("matches case-differing descendants when the policy is case-insensitive", () => {
    expect(matchRoot("/users/developer/workspace/config.json", roots, true)).toBe(roots[0]);
  });

  it("does not widen directory roots on a case-sensitive policy", () => {
    expect(matchRoot("/users/developer/workspace/config.json", roots, false)).toBeUndefined();
  });

  it("keeps exact and directory roots under one case policy", () => {
    expect(matchRoot("/users/developer/config.json", roots, true)).toBe(roots[1]);
  });
});
