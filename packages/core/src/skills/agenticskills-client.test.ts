import type { DirectorySkillSource, HttpGetRequest, HttpGetResult } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { treeHash } from "../workspace/skills.js";
import {
  okDirectoryResponse as ok,
  scriptedDirectoryEnvironment as scripted,
} from "./directory-client.test-support.js";
import { listDirectorySkills, resolveDirectorySkills } from "./directory-client.js";

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

describe("AgenticSkills provider", () => {
  it("translates the live catalog shape into versioned Aura listings", async () => {
    const { environment, requests } = scripted(() => ok({ skills: [CATALOG_ENTRY], total: 1 }));

    const result = await listDirectorySkills(environment, SOURCE);

    expect(result.status).toEqual({ kind: "available" });
    expect(result.diagnostics).toEqual([]);
    expect(result.listings).toEqual([
      {
        description: CATALOG_ENTRY.description,
        id: "find-skills",
        name: "Find Skills",
        originUrl: "https://github.com/vercel-labs/skills/tree/main/skills/find-skills",
        source: SOURCE,
        version: "2026.2.15",
      },
    ]);
    expect(requests[0]?.url).toBe("https://agenticskills.io/api/skills");
    expect(requests.map((request) => request.url)).toContain(
      "https://raw.githubusercontent.com/vercel-labs/skills/main/skills/find-skills/SKILL.md",
    );
  });

  it("keeps an entry listed when its probe failed for anything but a 404", async () => {
    const { environment } = scripted((request) => {
      if (request.url === "https://agenticskills.io/api/skills") {
        return ok({ skills: [CATALOG_ENTRY], total: 1 });
      }
      return { kind: "failure", reason: "timeout" };
    });

    const result = await listDirectorySkills(environment, SOURCE);

    expect(result.listings.map((listing) => listing.id)).toEqual(["find-skills"]);
    expect(result.diagnostics[0]?.message).toContain("listed but may fail to install");
  });

  it("probes each entry once and reads the catalog once across listing and resolving", async () => {
    const skill = "---\nname: find-skills\ndescription: Find skills.\n---\n";
    const { environment, requests } = scripted((request) => {
      if (request.url === "https://agenticskills.io/api/skills") {
        return ok({ skills: [CATALOG_ENTRY], total: 1 });
      }
      if (request.url.startsWith("https://api.github.com/")) {
        return ok([{ name: "SKILL.md", size: skill.length, type: "file" }]);
      }
      return bytes(skill);
    });

    await listDirectorySkills(environment, SOURCE);
    await resolveDirectorySkills(environment, SOURCE, ["find-skills"]);

    const catalogReads = requests.filter(
      (request) => request.url === "https://agenticskills.io/api/skills",
    );
    expect(catalogReads).toHaveLength(1);
  });

  it("names the GitHub rate limit rather than echoing its status code", async () => {
    const { environment } = scripted((request) => {
      if (request.url === "https://agenticskills.io/api/skills") {
        return ok({ skills: [CATALOG_ENTRY], total: 1 });
      }
      if (request.url.startsWith("https://api.github.com/")) {
        return { body: "", kind: "response", status: 403 };
      }
      return bytes("---\nname: find-skills\ndescription: Find skills.\n---\n");
    });

    const result = await resolveDirectorySkills(environment, SOURCE, ["find-skills"]);

    expect(result.skills).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain("rate-limited by GitHub");
    expect(result.diagnostics[0]?.message).not.toContain("403");
  });

  it("downloads the complete GitHub skill tree and skips binary files", async () => {
    const skill =
      "---\nname: find-skills\ndescription: Find skills.\n---\n\nRead references/guide.md.\n";
    const guide = "# Guide\n";
    const { environment, requests } = scripted((request) => responseForTree(request, skill, guide));

    const result = await resolveDirectorySkills(environment, SOURCE, ["find-skills"]);

    const files = [
      { content: skill, path: "SKILL.md" },
      { content: guide, path: "references/guide.md" },
    ];
    expect(result.diagnostics).toEqual([]);
    expect(result.skills).toEqual([
      {
        description: CATALOG_ENTRY.description,
        files,
        id: "find-skills",
        name: "Find Skills",
        source: SOURCE,
        treeHash: treeHash(files),
        version: "2026.2.15",
      },
    ]);
    expect(requests.map((request) => request.url)).toContain(
      "https://api.github.com/repos/vercel-labs/skills/contents/skills/find-skills?ref=main",
    );
    expect(requests.map((request) => request.url)).toContain(
      "https://raw.githubusercontent.com/vercel-labs/skills/main/skills/find-skills/references/guide.md",
    );
  });

  it("does not propose repository collections without an exact installable skill directory", async () => {
    const rootEntry = {
      ...CATALOG_ENTRY,
      githubUrl: "https://github.com/acme/root-skill",
      slug: "root-skill",
    };
    const { environment, requests } = scripted(() => ok({ skills: [rootEntry], total: 1 }));

    const result = await listDirectorySkills(environment, SOURCE);

    expect(result.diagnostics).toEqual([]);
    expect(result.listings).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it("does not propose stale GitHub directories without a SKILL.md", async () => {
    const stale = {
      ...CATALOG_ENTRY,
      githubUrl: "https://github.com/acme/skills/tree/main/skills/stale",
      slug: "stale",
    };
    const { environment } = scripted((request) => {
      if (request.url === "https://agenticskills.io/api/skills") {
        return ok({ skills: [CATALOG_ENTRY, stale], total: 2 });
      }
      if (request.url.includes("/stale/SKILL.md")) {
        return { body: new Uint8Array(), kind: "binary-response", status: 404 };
      }
      return bytes("---\nname: find-skills\ndescription: Find skills.\n---\n");
    });

    const result = await listDirectorySkills(environment, SOURCE);

    expect(result.diagnostics).toEqual([]);
    expect(result.listings.map((listing) => listing.id)).toEqual(["find-skills"]);
  });

  it("drops malformed entries without exposing their values", async () => {
    const { environment } = scripted(() =>
      ok({
        skills: [
          CATALOG_ENTRY,
          { ...CATALOG_ENTRY, githubUrl: "https://evil.example/secret", slug: "bad-source" },
          { ...CATALOG_ENTRY, lastUpdated: "not-a-date", slug: "bad-date" },
        ],
      }),
    );

    const result = await listDirectorySkills(environment, SOURCE);

    expect(result.listings.map((listing) => listing.id)).toEqual(["find-skills"]);
    expect(result.diagnostics[0]?.message).toContain("2 malformed or duplicate entries");
    expect(JSON.stringify(result.diagnostics)).not.toContain("evil.example");
    expect(JSON.stringify(result.diagnostics)).not.toContain("not-a-date");
  });

  it("refuses oversized GitHub trees before downloading their files", async () => {
    const { environment, requests } = scripted((request) => {
      if (request.url === "https://agenticskills.io/api/skills") {
        return ok({ skills: [CATALOG_ENTRY], total: 1 });
      }
      if (request.url.startsWith("https://api.github.com/")) {
        return ok(
          Array.from({ length: 6 }, (_, index) => ({
            name: index === 0 ? "SKILL.md" : `file-${String(index)}.txt`,
            size: 900_000,
            type: "file",
          })),
        );
      }
      return bytes("should not be downloaded");
    });

    const result = await resolveDirectorySkills(environment, SOURCE, ["find-skills"]);

    expect(result.skills).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain("5000000 byte limit");
    expect(requests).toHaveLength(2);
  });

  it("refuses non-portable GitHub paths without echoing them", async () => {
    const { environment } = scripted((request) => {
      if (request.url === "https://agenticskills.io/api/skills") {
        return ok({ skills: [CATALOG_ENTRY], total: 1 });
      }
      return ok([{ name: "../SECRET", size: 10, type: "file" }]);
    });

    const result = await resolveDirectorySkills(environment, SOURCE, ["find-skills"]);

    expect(result.skills).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain("non-portable path");
    expect(JSON.stringify(result.diagnostics)).not.toContain("SECRET");
  });
});

function responseForTree(request: HttpGetRequest, skill: string, guide: string): HttpGetResult {
  if (request.url === "https://agenticskills.io/api/skills") {
    return ok({ skills: [CATALOG_ENTRY], total: 1 });
  }
  if (
    request.url ===
    "https://api.github.com/repos/vercel-labs/skills/contents/skills/find-skills?ref=main"
  ) {
    return ok([
      { name: "SKILL.md", size: skill.length, type: "file" },
      { name: "references", size: 0, type: "dir" },
      { name: "logo.png", size: 1, type: "file" },
    ]);
  }
  if (
    request.url ===
    "https://api.github.com/repos/vercel-labs/skills/contents/skills/find-skills/references?ref=main"
  ) {
    return ok([{ name: "guide.md", size: guide.length, type: "file" }]);
  }
  if (
    request.url ===
    "https://raw.githubusercontent.com/vercel-labs/skills/main/skills/find-skills/SKILL.md"
  ) {
    return bytes(skill);
  }
  if (
    request.url ===
    "https://raw.githubusercontent.com/vercel-labs/skills/main/skills/find-skills/references/guide.md"
  ) {
    return bytes(guide);
  }
  if (
    request.url ===
    "https://raw.githubusercontent.com/vercel-labs/skills/main/skills/find-skills/logo.png"
  ) {
    return { body: new Uint8Array([0xff]), kind: "binary-response", status: 200 };
  }
  return { body: "missing", kind: "response", status: 404 };
}

function bytes(content: string): HttpGetResult {
  return { body: new TextEncoder().encode(content), kind: "binary-response", status: 200 };
}
