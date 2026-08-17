import type { Adapter } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { captureRegistryError, createAdapter, createPlugin } from "./plugin-fixtures.js";

describe("shared-link plugin validation", () => {
  it("rejects unsafe or incomplete declarations", () => {
    const traversal: Adapter = {
      ...createAdapter("traversal"),
      sharedLink: {
        entryPath: "./../AGENTS.md",
        kind: "native-copy",
        lineTemplate: "@file {{sharedInstructions}}",
      },
    };
    // The next two shapes no longer compile against the discriminated union, but a plugin shipped
    // as compiled JavaScript can still hand them over, so the runtime validation stays under test.
    const missingTemplate: Adapter = {
      ...createAdapter("missing-template"),
      // @ts-expect-error An import-line link without lineTemplate is only constructible untyped.
      sharedLink: { entryPath: "~/.agent/AGENTS.md", kind: "import-line" },
    };
    const duplicateToken: Adapter = {
      ...createAdapter("duplicate-token"),
      sharedLink: {
        entryPath: "~/.agent/AGENTS.md",
        kind: "import-line",
        lineTemplate: "{{sharedInstructions}} {{sharedInstructions}}",
      },
    };
    const symlinkTemplate: Adapter = {
      ...createAdapter("symlink-template"),
      sharedLink: {
        entryPath: "~/.agent/AGENTS.md",
        kind: "symlink",
        // @ts-expect-error A symlink link carrying lineTemplate is only constructible untyped.
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
