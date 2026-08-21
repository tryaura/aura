import type { AdapterFileSpec } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { buildWorkspaceModel } from "../index.js";
import { createMemoryReader, createTestAdapter, createTestEnvironment } from "./testing.js";

const INSTRUCTIONS: AdapterFileSpec = {
  id: "instructions",
  kind: "instructions",
  path: "/home/dev/CLAUDE.md",
  scope: "global",
};

describe("shared instruction model", () => {
  it("models missing, readable, and problematic shared instruction sources", async () => {
    const environment = createTestEnvironment();
    const missing = await buildWorkspaceModel({
      adapters: [],
      environment,
      reader: createMemoryReader(),
    });
    const readable = await buildWorkspaceModel({
      adapters: [],
      environment,
      reader: createMemoryReader({ "/home/dev/agents/AGENTS.md": "# Shared\n" }),
    });
    const problematic = await buildWorkspaceModel({
      adapters: [],
      environment,
      reader: createMemoryReader({}, { problems: { "/home/dev/agents/AGENTS.md": "denied" } }),
    });

    expect(missing.model.sharedInstructions).toEqual({
      content: undefined,
      exists: false,
      path: "/home/dev/agents/AGENTS.md",
      problem: undefined,
    });
    expect(readable.model.sharedInstructions).toEqual({
      content: "# Shared\n",
      exists: true,
      path: "/home/dev/agents/AGENTS.md",
      problem: undefined,
    });
    expect(problematic.model.sharedInstructions).toEqual({
      content: undefined,
      exists: true,
      path: "/home/dev/agents/AGENTS.md",
      problem: "denied",
    });
  });

  it("resolves a declared shared link and expands its template", async () => {
    const adapter = {
      ...createTestAdapter({ files: () => [INSTRUCTIONS] }),
      sharedLink: {
        entryPath: "~/CLAUDE.md",
        kind: "import-line" as const,
        lineTemplate: "@{{sharedInstructions}}",
      },
    };

    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createTestEnvironment(),
      reader: createMemoryReader({ "/home/dev/CLAUDE.md": "# Existing\n" }),
    });

    expect(diagnostics).toEqual([]);
    expect(model.apps[0]?.sharedLink).toEqual({
      content: "@~/agents/AGENTS.md",
      entryPath: "/home/dev/CLAUDE.md",
      kind: "import-line",
      scope: "global",
    });
  });

  it("reports a shared-link entry that files() did not declare", async () => {
    const adapter = {
      ...createTestAdapter(),
      sharedLink: { entryPath: "~/.fake/AGENTS.md", kind: "symlink" as const },
    };

    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createTestEnvironment(),
      reader: createMemoryReader(),
    });

    expect(model.apps[0]?.sharedLink).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ adapterId: "fake", phase: "files" });
    expect(diagnostics[0]?.detail).toContain("files() result did not declare that path");
  });
});
