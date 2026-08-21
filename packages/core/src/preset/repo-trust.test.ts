import { describe, expect, it } from "vitest";

import { createEnvironment } from "../environment.boundary.js";
import { createEmptyAuraManifest } from "../manifest/codec.js";
import { createMemoryReader, DIRECTORY, type MemoryEntries } from "../workspace/testing.js";
import { hashRepoPreset, isRepoPresetTrusted, readRepoPreset } from "./repo-trust.js";

const PATH = "/workspace/.aura/preset.json";
const DOCUMENT = '{"schemaVersion":1,"name":"Repo","checks":{"severity":{"INS-007":"error"}}}';

/** A linked worktree at `/home/dev/tree` off the primary checkout at `/home/dev/repo`. */
const WORKTREE: MemoryEntries = {
  "/home/dev/repo/.git": DIRECTORY,
  "/home/dev/tree/.aura/preset.json": DOCUMENT,
  "/home/dev/tree/.git": "gitdir: /home/dev/repo/.git/worktrees/tree\n",
};
const TREE_PATH = "/home/dev/tree/.aura/preset.json";
const MAIN_PATH = "/home/dev/repo/.aura/preset.json";

function environment(cwd = "/workspace") {
  return createEnvironment({ cwd, homeDir: "/home/dev" });
}

describe("readRepoPreset", () => {
  it("reads, validates, and hashes the repository preset", async () => {
    const state = await readRepoPreset(environment(), createMemoryReader({ [PATH]: DOCUMENT }));

    expect(state).toMatchObject({
      hash: hashRepoPreset(DOCUMENT),
      path: PATH,
      preset: { name: "Repo", schemaVersion: 1 },
      status: "ready",
    });
    expect(state.diagnostics).toEqual([]);
    expect(state.mainWorktreePath).toBeUndefined();
  });

  it("reports a missing file as the ordinary case", async () => {
    const state = await readRepoPreset(environment(), createMemoryReader());

    expect(state).toMatchObject({ path: PATH, status: "missing" });
    expect(state.hash).toBeUndefined();
  });

  it("fails closed with a diagnostic when the file is invalid", async () => {
    const state = await readRepoPreset(environment(), createMemoryReader({ [PATH]: "{ broken" }));

    expect(state.status).toBe("invalid");
    expect(state.preset).toBeUndefined();
    expect(state.diagnostics[0]?.message).toContain("is not valid JSON");
  });

  it("resolves the primary checkout as a second trust key inside a linked worktree", async () => {
    const state = await readRepoPreset(environment("/home/dev/tree"), createMemoryReader(WORKTREE));

    expect(state).toMatchObject({
      mainWorktreePath: MAIN_PATH,
      path: TREE_PATH,
      status: "ready",
    });
  });

  it("maps a preset below the worktree root onto the same position in the primary checkout", async () => {
    const state = await readRepoPreset(
      environment("/home/dev/tree/sub"),
      createMemoryReader({ ...WORKTREE, "/home/dev/tree/sub/.aura/preset.json": DOCUMENT }),
    );

    expect(state.mainWorktreePath).toBe("/home/dev/repo/sub/.aura/preset.json");
  });

  it("leaves the repository key unset in a primary checkout", async () => {
    const state = await readRepoPreset(
      environment("/home/dev/repo"),
      createMemoryReader({ "/home/dev/repo/.git": DIRECTORY, [MAIN_PATH]: DOCUMENT }),
    );

    expect(state.path).toBe(MAIN_PATH);
    expect(state.mainWorktreePath).toBeUndefined();
  });

  it("canonicalizes the working directory so a recorded key outlives the run that wrote it", async () => {
    const state = await readRepoPreset(
      environment("/link/workspace"),
      createMemoryReader({ [PATH]: DOCUMENT }, { links: { "/link/workspace": "/workspace" } }),
    );

    expect(state.path).toBe(PATH);
  });

  it("does not walk for a repository key when no preset was read", async () => {
    const reader = createMemoryReader(WORKTREE);

    await readRepoPreset(environment("/home/dev/empty"), reader);

    expect(reader.reads.some((path) => path.endsWith("/.git"))).toBe(false);
  });

  it("skips skill discovery when the caller only needs trust-hashed content", async () => {
    const skillsRoot = "/workspace/.aura/skills";
    const reader = createMemoryReader({
      [PATH]: DOCUMENT,
      [skillsRoot]: DIRECTORY,
      [`${skillsRoot}/review`]: DIRECTORY,
      [`${skillsRoot}/review/SKILL.md`]: "Review.\n",
    });

    const state = await readRepoPreset(environment(), reader, { includeSkills: false });

    expect(state.contentSet?.skills).toEqual([]);
    expect(reader.reads).not.toContain(skillsRoot);
  });
});

describe("hashRepoPreset", () => {
  it("does not change across line-ending rewrites of the same contents", () => {
    expect(hashRepoPreset('{"a":1}\n')).toBe(hashRepoPreset('{"a":1}\r\n'));
    expect(hashRepoPreset('{"a":1}')).not.toBe(hashRepoPreset('{"a":2}'));
  });
});

describe("isRepoPresetTrusted", () => {
  const hash = hashRepoPreset(DOCUMENT);
  const manifest = {
    ...createEmptyAuraManifest(),
    trustedRepoPresets: [{ hash, path: PATH }],
  };

  function trusting(
    ...entries: readonly { hash: string; mainWorktreePath?: string; path: string }[]
  ) {
    return { ...createEmptyAuraManifest(), trustedRepoPresets: entries };
  }

  it("matches only the exact path and contents that were accepted", () => {
    expect(isRepoPresetTrusted(manifest, { path: PATH }, hash)).toBe(true);
    expect(isRepoPresetTrusted(manifest, { path: PATH }, hashRepoPreset("{}"))).toBe(false);
    expect(isRepoPresetTrusted(manifest, { path: "/elsewhere/.aura/preset.json" }, hash)).toBe(
      false,
    );
    expect(isRepoPresetTrusted(undefined, { path: PATH }, hash)).toBe(false);
    expect(isRepoPresetTrusted(createEmptyAuraManifest(), { path: PATH }, hash)).toBe(false);
  });

  it("matches an acceptance recorded from a sibling worktree of the same checkout", () => {
    const recorded = trusting({
      hash,
      mainWorktreePath: MAIN_PATH,
      path: "/home/dev/other/.aura/preset.json",
    });

    expect(
      isRepoPresetTrusted(recorded, { mainWorktreePath: MAIN_PATH, path: TREE_PATH }, hash),
    ).toBe(true);
  });

  it("does not give the primary checkout standing from a linked-worktree acceptance", () => {
    const recorded = trusting({
      hash,
      mainWorktreePath: MAIN_PATH,
      path: TREE_PATH,
    });

    expect(isRepoPresetTrusted(recorded, { path: MAIN_PATH }, hash)).toBe(false);
  });

  it("matches an acceptance an older build recorded in the primary checkout itself", () => {
    const recorded = trusting({ hash, path: MAIN_PATH });

    expect(
      isRepoPresetTrusted(recorded, { mainWorktreePath: MAIN_PATH, path: TREE_PATH }, hash),
    ).toBe(true);
  });

  it("still requires the exact contents within one checkout", () => {
    const recorded = trusting({
      hash,
      mainWorktreePath: MAIN_PATH,
      path: "/home/dev/other/.aura/preset.json",
    });

    expect(
      isRepoPresetTrusted(
        recorded,
        { mainWorktreePath: MAIN_PATH, path: TREE_PATH },
        hashRepoPreset("{}"),
      ),
    ).toBe(false);
  });

  it("does not match a different checkout holding identical contents", () => {
    const recorded = trusting({
      hash,
      mainWorktreePath: "/home/dev/fork/.aura/preset.json",
      path: "/home/dev/fork-tree/.aura/preset.json",
    });

    expect(
      isRepoPresetTrusted(recorded, { mainWorktreePath: MAIN_PATH, path: TREE_PATH }, hash),
    ).toBe(false);
  });
});
