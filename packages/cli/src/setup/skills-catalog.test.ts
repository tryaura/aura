import type { DirectorySkillSource, HttpGetRequest, HttpGetResult } from "@tryaura/aura-sdk";
import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";
import { describe, expect, it } from "vitest";

import { createEnvironment } from "@tryaura/core";

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
    preset: undefined,
    presetNotes: [],
    registryDirectories: sources,
  });
}

describe("createSkillCatalog", () => {
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

    const unapproved = await skills.load();
    expect(requests).toEqual([]);
    expect(unapproved.unavailableSources[0]?.hint).toContain("connection not approved");

    await skills.load(new Set([source.id]));
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

    await skills.load();

    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(4);
  });
});
