import { describe, expect, it } from "vitest";

import { displayPath } from "./display-path.js";

const ROOTS = { cwd: "/work/project/packages/cli", homeDir: "/home/dev" };

describe("displayPath", () => {
  it("anchors on the project root rather than the invocation directory", () => {
    const roots = { ...ROOTS, projectRoot: "/work/project" };

    expect(displayPath("/work/project/README.md", roots)).toBe("README.md");
    expect(displayPath("/work/project/packages/cli/src/run.boundary.ts", roots)).toBe(
      "packages/cli/src/run.boundary.ts",
    );
  });

  it("falls back to the invocation directory outside a repository", () => {
    expect(displayPath("/work/project/packages/cli/src/run.boundary.ts", ROOTS)).toBe(
      "src/run.boundary.ts",
    );
  });

  it("shortens home paths with a forward slash on every platform", () => {
    expect(displayPath("/home/dev/agents/AGENTS.md", ROOTS)).toBe("~/agents/AGENTS.md");
  });

  it("leaves a path under neither root absolute", () => {
    expect(displayPath("/etc/agents/AGENTS.md", ROOTS)).toBe("/etc/agents/AGENTS.md");
    // A sibling of the project is not addressable relatively, so it stays whole rather than
    // becoming a chain of `..` the user has to unwind.
    expect(displayPath("/work/other/file.md", { ...ROOTS, projectRoot: "/work/project" })).toBe(
      "/work/other/file.md",
    );
  });

  it("leaves a root itself absolute rather than naming it with a bare dot", () => {
    expect(displayPath("/home/dev", ROOTS)).toBe("/home/dev");
  });
});
