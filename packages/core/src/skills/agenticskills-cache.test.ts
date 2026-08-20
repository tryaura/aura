import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const CATALOG_ENTRY = {
  description: "Discover skills from the ecosystem.",
  githubUrl: "https://github.com/vercel-labs/skills/tree/main/skills/find-skills",
  lastUpdated: "2026-02-15",
  name: "Find Skills",
  slug: "find-skills",
};

describe("AgenticSkills catalog cache", () => {
  it("serves the provider catalog from a fresh disk cache across runs", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "aura-agentic-cache-"));
    const first = scripted(() => ok({ skills: [CATALOG_ENTRY], total: 1 }));
    await listDirectorySkills({ ...first.environment, homeDir }, SOURCE);

    // A separate environment on the same home directory models the next run of the process.
    const second = scripted(() => {
      throw new Error("the second run must not fetch the feed");
    });
    const result = await listDirectorySkills({ ...second.environment, homeDir }, SOURCE);

    expect(result.listings.map((listing) => listing.id)).toEqual(["find-skills"]);
    expect(result.diagnostics[0]?.message).toContain("served from the local cache");
    expect(second.requests.filter((request) => !request.url.includes("api.github.com"))).toEqual(
      [],
    );
  });
});
