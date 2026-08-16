import { describe, expect, it } from "vitest";

import { captureRegistryError, createAdapter, createPlugin } from "./plugin-fixtures.js";

describe("shared-link plugin validation", () => {
  it("rejects unsafe or incomplete declarations", () => {
    const traversal = {
      ...createAdapter("traversal"),
      sharedLink: {
        entryPath: "./../AGENTS.md",
        kind: "native-copy" as const,
        lineTemplate: "@file {{sharedInstructions}}",
      },
    };
    const missingTemplate = {
      ...createAdapter("missing-template"),
      sharedLink: { entryPath: "~/.agent/AGENTS.md", kind: "import-line" as const },
    };
    const duplicateToken = {
      ...createAdapter("duplicate-token"),
      sharedLink: {
        entryPath: "~/.agent/AGENTS.md",
        kind: "import-line" as const,
        lineTemplate: "{{sharedInstructions}} {{sharedInstructions}}",
      },
    };
    const symlinkTemplate = {
      ...createAdapter("symlink-template"),
      sharedLink: {
        entryPath: "~/.agent/AGENTS.md",
        kind: "symlink" as const,
        lineTemplate: "{{sharedInstructions}}",
      },
    };

    const error = captureRegistryError([
      createPlugin("links", {
        adapters: [traversal, missingTemplate, duplicateToken, symlinkTemplate],
      }),
    ]);

    expect(error.message).toContain("normalized portable path without traversal");
    expect(error.message).toContain("import-line declarations require lineTemplate");
    expect(error.message).toContain("must contain exactly one {{sharedInstructions}} token");
    expect(error.message).toContain("symlink declarations must not provide lineTemplate");
  });
});
