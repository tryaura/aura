import type { Adapter } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { captureRegistryError, createAdapter, createPlugin } from "./plugin-fixtures.js";
import { createPluginRegistry } from "./plugin-registry.js";

describe("skill capability plugin validation", () => {
  it("rejects empty and project-scoped skill directory declarations", () => {
    const empty: Adapter = {
      ...createAdapter("empty-skills"),
      capabilities: { skills: { directories: [] } },
    };
    const project: Adapter = {
      ...createAdapter("project-skills"),
      capabilities: {
        skills: {
          directories: [{ entryPath: "./.agent/skills", id: "project-skills.project" }],
        },
      },
    };

    const error = captureRegistryError([createPlugin("skills", { adapters: [empty, project] })]);

    expect(error.message).toContain("without a global skills directory");
    expect(error.message).toContain("declares invalid global skills directory ./.agent/skills");
  });

  it("accepts global home-relative skill directories", () => {
    const global: Adapter = {
      ...createAdapter("global-skills"),
      capabilities: {
        skills: {
          directories: [{ entryPath: "~/.agent/skills", id: "global-skills.global" }],
        },
      },
    };

    expect(() =>
      createPluginRegistry([createPlugin("skills", { adapters: [global] })]),
    ).not.toThrow();
  });
});
