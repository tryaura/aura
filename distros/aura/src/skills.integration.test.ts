import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { createMockDirectoryBuilder, createSeedBuilder, runSetup } from "@tryaura/aura-testkit";
import { describe, expect, it } from "vitest";

import { AURA_DISTRO } from "./distro.js";

const TOKEN = "sk-fixture-secret";
const SKILL_MD = "---\nname: review\n---\n\nReview changes before landing.\n";

const LISTING = {
  description: "Review changes before landing.",
  id: "review",
  name: "Review",
  version: "1.0.0",
};

/** The same signature core computes, so a seeded manifest can claim the mock's content. */
function treeHash(files: readonly { readonly content: string; readonly path: string }[]): string {
  const signature = [...files]
    .sort((left, right) => (left.path < right.path ? -1 : 1))
    .map(
      (file) => `f:${file.path}:${createHash("sha256").update(file.content, "utf8").digest("hex")}`,
    )
    .join("\n");
  return createHash("sha256").update(`${signature}\n`, "utf8").digest("hex");
}

function presetJson(url: string, allowed: readonly string[]): string {
  return JSON.stringify({
    allowedSkillSources: allowed,
    schemaVersion: 1,
    skillDirectories: [
      {
        id: "directory:acme",
        name: "Acme Skills",
        tokenEnv: "ACME_SKILLS_TOKEN",
        url,
      },
    ],
  });
}

function manifestJson(skills: readonly unknown[]): string {
  return `${JSON.stringify(
    { apps: {}, mcpServers: [], ownership: {}, schemaVersion: 1, skills, snippets: [] },
    undefined,
    2,
  )}\n`;
}

/** Every file below `root`, path → contents, for proving what a run never wrote. */
async function allFiles(root: string): Promise<Readonly<Record<string, string>>> {
  const contents: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        contents[path] = await readFile(path, "utf8");
      }
    }
  };
  await walk(root);
  return contents;
}

describe("aura setup with a skill directory", () => {
  it("re-applies reviewed provenance under --yes and never persists the token", async () => {
    await using directory = await createMockDirectoryBuilder()
      .skill(LISTING, [{ content: SKILL_MD, path: "SKILL.md" }])
      .requireToken(TOKEN)
      .build();
    const recorded = {
      id: "review",
      pinned: false,
      source: "directory:acme",
      treeHash: treeHash([{ content: SKILL_MD, path: "SKILL.md" }]),
      version: "1.0.0",
    };
    await using seed = await createSeedBuilder()
      .homeFile("agents/aura.json", manifestJson([recorded]))
      .workspaceFile(".aura/preset.json", presetJson(directory.url, ["directory:acme"]))
      .build();

    const result = await runSetup({
      distro: AURA_DISTRO,
      environmentVariables: { ACME_SKILLS_TOKEN: TOKEN },
      seed,
    });

    expect(result.exitCode).toBe(0);
    await expect(
      readFile(join(seed.homeDir, "agents", "skills", "review", "SKILL.md"), "utf8"),
    ).resolves.toBe(SKILL_MD);
    // The token went to the directory as a bearer header and nowhere else.
    expect(directory.requests.length).toBeGreaterThanOrEqual(2);
    for (const request of directory.requests) {
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
    }
    for (const [path, content] of Object.entries(await allFiles(seed.homeDir))) {
      expect(content, path).not.toContain(TOKEN);
    }
    expect(result.stdout).not.toContain(TOKEN);
    expect(result.stderr).not.toContain(TOKEN);
  });

  it("refuses a manifest entry from a disallowed source before anything is written", async () => {
    await using seed = await createSeedBuilder()
      .homeFile(
        "agents/aura.json",
        manifestJson([
          {
            id: "review",
            pinned: false,
            source: "directory:evil",
            treeHash: "0".repeat(64),
            version: "1.0.0",
          },
        ]),
      )
      .workspaceFile(".aura/preset.json", presetJson("https://acme.example", ["plugin:official"]))
      .build();

    const result = await runSetup({ distro: AURA_DISTRO, seed });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain('team preset ".aura/preset.json"');
    expect(result.stderr).toContain("blocked");
    expect(result.diffs).toEqual([]);
  });

  it("surfaces a rejected token by variable name, never by value", async () => {
    await using directory = await createMockDirectoryBuilder()
      .skill(LISTING, [{ content: SKILL_MD, path: "SKILL.md" }])
      .requireToken(TOKEN)
      .build();
    await using seed = await createSeedBuilder()
      .workspaceFile(".aura/preset.json", presetJson(directory.url, ["directory:acme"]))
      .build();

    const result = await runSetup({
      distro: AURA_DISTRO,
      environmentVariables: { ACME_SKILLS_TOKEN: "sk-wrong-token" },
      seed,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'Skill source "directory:acme" rejected the token from ACME_SKILLS_TOKEN, so it is unavailable.',
    );
    expect(result.stdout).not.toContain("sk-wrong-token");
  });

  it("runs --add skill standalone against an established machine", async () => {
    await using directory = await createMockDirectoryBuilder()
      .skill(LISTING, [{ content: SKILL_MD, path: "SKILL.md" }])
      .build();
    await using seed = await createSeedBuilder()
      .workspaceFile(".aura/preset.json", presetJson(directory.url, ["directory:acme"]))
      .build();
    await runSetup({ distro: AURA_DISTRO, seed });

    const targeted = await runSetup({
      args: ["--add", "skill"],
      distro: AURA_DISTRO,
      seed,
    });

    expect(targeted.exitCode).toBe(0);
    expect(targeted.diffs).toEqual([]);
    expect(targeted.stdout).toContain("Already converged — nothing to do.");
  });

  it("requires an established manifest before --add skill runs alone", async () => {
    await using seed = await createSeedBuilder().build();

    const targeted = await runSetup({ args: ["--add", "skill"], distro: AURA_DISTRO, seed });

    expect(targeted.exitCode).toBe(2);
    expect(targeted.stderr).toContain("the Skills step needs an Aura manifest");
  });
});
