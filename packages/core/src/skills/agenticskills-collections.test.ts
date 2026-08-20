import type { DirectorySkillSource } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import {
  okDirectoryResponse as ok,
  scriptedDirectoryEnvironment as scripted,
} from "./directory-client.test-support.js";
import { listDirectorySkills } from "./directory-client.js";

const SOURCE: DirectorySkillSource = {
  id: "directory:agenticskills",
  kind: "directory",
  name: "agenticskills.io",
  protocol: "agenticskills",
  url: "https://agenticskills.io",
};

function entry(slug: string): Record<string, string> {
  return {
    description: `The ${slug} skill.`,
    githubUrl: `https://github.com/vercel-labs/skills/tree/main/skills/${slug}`,
    lastUpdated: "2026-02-15",
    name: slug,
    slug,
  };
}

describe("AgenticSkills catalog collections", () => {
  it("lists advertised collections restricted to skills the catalog offers", async () => {
    const { environment } = scripted(() =>
      ok({
        collections: [
          {
            description: "The everyday starter set.",
            id: "starter",
            name: "Starter",
            skillIds: ["review", "triage", "not-advertised", "review"],
          },
          { id: "broken", name: "", skillIds: ["review"] },
          { description: "Empty.", id: "empty", name: "Empty", skillIds: ["not-advertised"] },
        ],
        skills: [entry("review"), entry("triage")],
        total: 2,
      }),
    );

    const result = await listDirectorySkills(environment, SOURCE, { noCache: true });

    expect(result.collections).toEqual([
      {
        description: "The everyday starter set.",
        id: "starter",
        name: "Starter",
        skillIds: ["review", "triage"],
      },
    ]);
    expect(result.diagnostics).toEqual([]);
  });
});
