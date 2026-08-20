import type { Adapter } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { captureRegistryError, createAdapter, createPlugin } from "./plugin-fixtures.js";
import { createPluginRegistry } from "./plugin-registry.js";

describe("shared-link plugin validation", () => {
  it("rejects unsafe or incomplete declarations", () => {
    const traversal: Adapter = {
      ...createAdapter("traversal"),
      projectSharedLink: {
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

  // The write side recognizes an import it already added by matching the rendered line; a template
  // spanning lines matches nothing it wrote, so every run would append another copy.
  it("refuses a multi-line import-line template but allows one in a native-copy wrapper", () => {
    const multiLineImport: Adapter = {
      ...createAdapter("multi-line"),
      sharedLink: {
        entryPath: "~/.agent/AGENTS.md",
        kind: "import-line",
        lineTemplate: "# Shared\n@file {{sharedInstructions}}",
      },
    };

    const error = captureRegistryError([createPlugin("multi", { adapters: [multiLineImport] })]);

    expect(error.message).toContain("import-line lineTemplate must be a single line");
  });

  it("allows a native-copy wrapper whose template spans lines", () => {
    const wrapper: Adapter = {
      ...createAdapter("wrapper"),
      sharedLink: {
        entryPath: "~/.agent/rules.md",
        kind: "native-copy",
        lineTemplate: "---\nalwaysApply: true\n---\n\n@file {{sharedInstructions}}\n",
      },
    };

    expect(() =>
      createPluginRegistry([createPlugin("wrap", { adapters: [wrapper] })]),
    ).not.toThrow();
  });

  it("refuses a declaration whose entry does not live in its slot's scope", () => {
    // The shape that made a home-scoped check demand a file in whichever repository the user was
    // standing in, and write their home directory into it absolutely.
    const projectEntryGlobalSlot: Adapter = {
      ...createAdapter("global-slot"),
      sharedLink: {
        entryPath: "./.agent/rules.md",
        kind: "native-copy",
        lineTemplate: "@file {{sharedInstructions}}",
      },
    };
    const homeEntryProjectSlot: Adapter = {
      ...createAdapter("project-slot"),
      projectSharedLink: {
        entryPath: "~/.agent/rules.md",
        kind: "native-copy",
        lineTemplate: "@file {{sharedInstructions}}",
      },
    };

    const error = captureRegistryError([
      createPlugin("scopes", { adapters: [projectEntryGlobalSlot, homeEntryProjectSlot] }),
    ]);

    expect(error.message).toContain(
      'adapter "global-slot" declares invalid sharedLink: entryPath must begin with "~/" at global scope',
    );
    expect(error.message).toContain(
      'adapter "project-slot" declares invalid projectSharedLink: entryPath must begin with "./" at project scope',
    );
  });

  it("refuses a global link that is also declared not applicable", () => {
    const contradictory: Adapter = {
      ...createAdapter("contradictory"),
      capabilities: { instructions: { globalSharedLink: "not-applicable" } },
      sharedLink: { entryPath: "~/.agent/AGENTS.md", kind: "symlink" },
    };

    const error = captureRegistryError([createPlugin("links", { adapters: [contradictory] })]);

    expect(error.message).toContain(
      'declares both sharedLink and capabilities.instructions.globalSharedLink "not-applicable"',
    );
  });
});
