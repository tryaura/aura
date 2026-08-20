import type { DirectorySkillSource, HttpGetRequest, HttpGetResult } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { createTestEnvironment } from "../workspace/testing.js";
import { MAX_REPO_TREE_BYTES } from "./limits.js";
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

const CATALOG_ENTRY: AgenticFixtureEntry = {
  description: "Discover skills from the ecosystem.",
  githubUrl: "https://github.com/vercel-labs/skills/tree/main/skills/find-skills",
  lastUpdated: "2026-02-15",
  name: "Find Skills",
  slug: "find-skills",
};

describe("AgenticSkills repository verification", () => {
  it("keeps a stale feed entry, disables it after verification, and fails its resolution alone", async () => {
    const stale = {
      ...CATALOG_ENTRY,
      githubUrl: "https://github.com/acme/skills/tree/main/skills/stale",
      slug: "stale",
    };
    const { environment } = scripted((request) => {
      if (request.url === "https://agenticskills.io/api/skills") {
        return ok({ skills: [CATALOG_ENTRY, stale], total: 2 });
      }
      if (request.url.includes("/git/trees/")) {
        return ok({
          tree: [{ path: "skills/find-skills/SKILL.md", type: "blob" }],
          truncated: false,
        });
      }
      return { body: "missing", kind: "response", status: 404 };
    });

    const result = await listDirectorySkills(environment, SOURCE);
    const verification = requireVerification(result);
    let updates = 0;
    const unsubscribe = verification.subscribe(() => {
      updates += 1;
    });
    await verification.settled;

    expect(result.listings.map((listing) => listing.id)).toEqual(["find-skills", "stale"]);
    expect(verification.isMissing("find-skills")).toBe(false);
    expect(verification.isMissing("stale")).toBe(true);
    expect(updates).toBe(1);
    unsubscribe();

    const resolved = await resolveDirectorySkills(environment, SOURCE, ["stale"]);
    expect(resolved.skills).toEqual([]);
    expect(resolved.diagnostics).toHaveLength(1);
    expect(resolved.diagnostics[0]?.message).toContain('Skill "stale"');
    expect(resolved.diagnostics[0]?.message).toContain("HTTP 404");
  });

  it("opens a 1117-entry listing before its single repository verification settles", async () => {
    const catalog = largeCatalog(1);
    const requests: HttpGetRequest[] = [];
    const tree = Promise.withResolvers<HttpGetResult>();
    const environment = createTestEnvironment({
      httpGet: (request) => {
        requests.push(request);
        return request.url === "https://agenticskills.io/api/skills"
          ? Promise.resolve(ok({ skills: catalog, total: catalog.length }))
          : tree.promise;
      },
    });

    const result = await listDirectorySkills(environment, SOURCE);
    const verification = requireVerification(result);
    let settled = false;
    const settlement = verification.settled.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(result.listings).toHaveLength(1_117);
    expect(treeRequests(requests)).toHaveLength(1);
    expect(treeRequests(requests)[0]?.maxResponseBytes).toBe(MAX_REPO_TREE_BYTES);
    tree.resolve(repositoryTree(catalog));
    await settlement;
  });

  it("uses exactly one recursive tree request for each of three repositories", async () => {
    const catalog = largeCatalog(3);
    const { environment, requests } = scripted((request) =>
      request.url === "https://agenticskills.io/api/skills"
        ? ok({ skills: catalog, total: catalog.length })
        : repositoryTree(catalog),
    );

    const result = await listDirectorySkills(environment, SOURCE);
    await requireVerification(result).settled;

    expect(treeRequests(requests)).toHaveLength(3);
    expect(new Set(treeRequests(requests).map((request) => request.url)).size).toBe(3);
  });

  it("trusts the feed when GitHub marks a recursive tree as truncated", async () => {
    const { environment } = scripted((request) =>
      request.url === "https://agenticskills.io/api/skills"
        ? ok({ skills: [CATALOG_ENTRY], total: 1 })
        : ok({ tree: [], truncated: true }),
    );

    const result = await listDirectorySkills(environment, SOURCE);
    const verification = requireVerification(result);
    await verification.settled;

    expect(verification.isMissing("find-skills")).toBe(false);
  });
});

function requireVerification(
  result: Awaited<ReturnType<typeof listDirectorySkills>>,
): NonNullable<Awaited<ReturnType<typeof listDirectorySkills>>["verification"]> {
  if (result.verification === undefined) {
    throw new Error("expected AgenticSkills repository verification");
  }
  return result.verification;
}

interface AgenticFixtureEntry {
  readonly description: string;
  readonly githubUrl: string;
  readonly lastUpdated: string;
  readonly name: string;
  readonly slug: string;
}

function largeCatalog(repositoryCount: number): readonly AgenticFixtureEntry[] {
  return Array.from({ length: 1_117 }, (_, index) => {
    const number = String(index + 1).padStart(4, "0");
    const repository = `catalog-${String(index % repositoryCount)}`;
    return {
      description: `Fixture skill ${number}.`,
      githubUrl: `https://github.com/atlassian/${repository}/tree/main/skills/skill-${number}`,
      lastUpdated: "2026-08-20",
      name: `Skill ${number}`,
      slug: `skill-${number}`,
    };
  });
}

function repositoryTree(entries: readonly AgenticFixtureEntry[]): HttpGetResult {
  return ok({
    tree: entries.map((entry) => ({
      path: `${new URL(entry.githubUrl).pathname.split("/tree/main/")[1]}/SKILL.md`,
      type: "blob",
    })),
    truncated: false,
  });
}

function treeRequests(requests: readonly HttpGetRequest[]): readonly HttpGetRequest[] {
  return requests.filter((request) => request.url.includes("/git/trees/"));
}
