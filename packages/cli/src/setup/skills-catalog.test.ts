import type {
  DirectorySkillSource,
  HttpGetRequest,
  HttpGetResult,
  SkillSourceDriver,
} from "@tryaura/aura-sdk";
import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";
import { describe, expect, it, vi } from "vitest";

import { createEnvironment } from "@tryaura/core";

import { skillIdentity } from "./skill-planner-paths.js";
import { createSkillCatalog } from "./skills-catalog.js";

function catalog(
  sources: readonly DirectorySkillSource[],
  httpGet: (request: HttpGetRequest) => Promise<HttpGetResult>,
  variables: Readonly<Record<string, string>> = {},
) {
  return createSkillCatalog({
    environment: createEnvironment({
      cwd: "/workspace",
      environmentVariables: variables,
      homeDir: "/home/dev",
      httpGet,
    }),
    model: createWorkspaceModel({
      manifest: { exists: false, path: "/home/dev/agents/aura.json", status: "missing" },
      sharedInstructions: { exists: false, path: "/home/dev/agents/AGENTS.md" },
    }),
    interactive: true,
    preset: undefined,
    presetNotes: [],
    registryDirectories: sources,
  });
}

describe("createSkillCatalog", () => {
  it("lists allowed drivers lazily once and never lists them for non-interactive setup", async () => {
    const allowed = driver("acme/allowed");
    const blocked = driver("acme/blocked");
    const inputs = {
      environment: createEnvironment({ cwd: "/workspace", homeDir: "/home/dev" }),
      model: createWorkspaceModel({
        manifest: { exists: false, path: "/home/dev/agents/aura.json", status: "missing" },
        sharedInstructions: { exists: false, path: "/home/dev/agents/AGENTS.md" },
      }),
      preset: {
        allowedSkillSources: ["driver:acme/allowed" as const],
        schemaVersion: 1 as const,
      },
      presetNotes: [],
      registryDirectories: [],
      registryDrivers: [allowed, blocked],
    };
    const interactive = createSkillCatalog({ ...inputs, interactive: true });

    expect(allowed.list).not.toHaveBeenCalled();
    await interactive.load();
    await interactive.load();

    expect(allowed.list).toHaveBeenCalledTimes(1);
    expect(blocked.list).not.toHaveBeenCalled();
    expect((await interactive.load()).entries[0]).toMatchObject({
      id: "review",
      sourceId: "driver:acme/allowed",
    });

    const nonInteractive = createSkillCatalog({ ...inputs, interactive: false });
    await nonInteractive.load();
    expect(allowed.list).toHaveBeenCalledTimes(1);
  });

  it("does not read or send a private token before its source is approved", async () => {
    const requests: HttpGetRequest[] = [];
    const source: DirectorySkillSource = {
      id: "directory:acme",
      kind: "private-directory",
      name: "Acme Skills",
      tokenEnv: "ACME_SKILLS_TOKEN",
      url: "https://skills.acme.example",
    };
    const skills = catalog(
      [source],
      (request) => {
        requests.push(request);
        return Promise.resolve({ body: "[]", kind: "response", status: 200 });
      },
      { ACME_SKILLS_TOKEN: "secret" },
    );

    expect(skills.pendingSources()).toEqual([]);
    const unapproved = await skills.load();
    expect(requests).toEqual([]);
    expect(unapproved.unavailableSources[0]?.hint).toContain("connection not approved");

    const approved = new Set([source.id]);
    expect(skills.pendingSources(approved)).toEqual([{ id: source.id, name: source.name }]);
    await skills.load(approved);
    expect(requests[0]?.headers).toEqual({ Authorization: "Bearer secret" });
  });

  it("bounds concurrent directory listing requests", async () => {
    let active = 0;
    let maximum = 0;
    const sources: DirectorySkillSource[] = Array.from({ length: 12 }, (_, index) => ({
      id: `directory:d${String(index)}`,
      kind: "directory",
      name: `Directory ${String(index)}`,
      url: `https://d${String(index)}.example`,
    }));
    const skills = catalog(sources, () => {
      active += 1;
      maximum = Math.max(maximum, active);
      return new Promise((resolve) => {
        queueMicrotask(() => {
          active -= 1;
          resolve({ body: "[]", kind: "response", status: 200 });
        });
      });
    });
    const updates: string[] = [];

    expect(skills.pendingSources()).toEqual(
      sources.map((source) => ({ id: source.id, name: source.name })),
    );

    await skills.load(undefined, (id, status) => {
      updates.push(`${id}:${status}`);
    });

    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(4);
    expect(updates.filter((update) => update.endsWith(":active"))).toHaveLength(12);
    expect(updates.filter((update) => update.endsWith(":complete"))).toHaveLength(12);
    expect(skills.pendingSources()).toEqual([]);

    const memoizedUpdates: string[] = [];
    await skills.load(undefined, (id, status) => {
      memoizedUpdates.push(`${id}:${status}`);
    });
    expect(memoizedUpdates).toEqual([]);
  });

  it("maps background AgenticSkills verification onto source-qualified picker identities", async () => {
    const source: DirectorySkillSource = {
      id: "directory:agenticskills",
      kind: "directory",
      name: "AgenticSkills",
      protocol: "agenticskills",
      url: "https://agenticskills.io",
    };
    const skills = catalog([source], (request) =>
      Promise.resolve(
        request.url === "https://agenticskills.io/api/skills"
          ? jsonResponse({
              skills: [agenticEntry("current", "Current"), agenticEntry("stale", "Stale")],
            })
          : jsonResponse({
              tree: [{ path: "skills/current/SKILL.md", type: "blob" }],
              truncated: false,
            }),
      ),
    );

    const listing = await skills.load();
    const verification = listing.verification;
    if (verification === undefined) {
      throw new Error("expected AgenticSkills verification");
    }
    await verification.settled;

    expect(verification.isMissing(skillIdentity(source.id, "current"))).toBe(false);
    expect(verification.isMissing(skillIdentity(source.id, "stale"))).toBe(true);
  });
});

function agenticEntry(slug: string, name: string) {
  return {
    description: `${name} skill.`,
    githubUrl: `https://github.com/acme/skills/tree/main/skills/${slug}`,
    lastUpdated: "2026-08-20",
    name,
    slug,
  };
}

function jsonResponse(body: unknown): HttpGetResult {
  return { body: JSON.stringify(body), kind: "response", status: 200 };
}

function driver(id: string): SkillSourceDriver & { readonly list: ReturnType<typeof vi.fn> } {
  return {
    description: "Fixture driver.",
    id,
    list: vi.fn().mockResolvedValue([
      {
        description: "Reviews changes.",
        id: "review",
        name: "Review",
        originUrl: "https://skills.example.com/review",
        version: "1.0.0",
      },
    ]),
    name: id,
    resolve: vi.fn().mockResolvedValue(new Map()),
  };
}
