import { describe, expect, it } from "vitest";

import { createMemoryReader, DIRECTORY } from "../workspace/testing.js";
import { resolveRepoSkills } from "./repo-source.js";

const ROOT = "/workspace/.aura/skills";
const BOUNDARY = "/workspace/.aura";
const BUDGET = 16_000_000;

describe("resolveRepoSkills", () => {
  it("returns nothing for a missing directory", async () => {
    const result = await resolveRepoSkills(ROOT, BOUNDARY, createMemoryReader(), BUDGET);

    expect(result).toEqual({ diagnostics: [], skills: [] });
  });

  it("skips a non-kebab entry with a diagnostic that does not echo it", async () => {
    const reader = createMemoryReader({
      [ROOT]: DIRECTORY,
      [`${ROOT}/Bad Entry`]: DIRECTORY,
      [`${ROOT}/Bad Entry/SKILL.md`]: "Body.\n",
    });

    const result = await resolveRepoSkills(ROOT, BOUNDARY, reader, BUDGET);

    expect(result.skills).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain("kebab-case");
    expect(result.diagnostics[0]?.message).not.toContain("Bad Entry");
  });

  it("refuses a skill tree holding a symbolic link", async () => {
    const reader = createMemoryReader(
      {
        [ROOT]: DIRECTORY,
        [`${ROOT}/leaky`]: DIRECTORY,
        [`${ROOT}/leaky/SKILL.md`]: "Body.\n",
        [`${ROOT}/leaky/secret.md`]: "never read",
      },
      { links: { [`${ROOT}/leaky/secret.md`]: "/home/dev/.ssh/id_ed25519" } },
    );

    const result = await resolveRepoSkills(ROOT, BOUNDARY, reader, BUDGET);

    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
  });

  it("stops reading skills when an earlier tree exhausts the byte budget", async () => {
    const reader = createMemoryReader({
      [ROOT]: DIRECTORY,
      [`${ROOT}/big`]: DIRECTORY,
      [`${ROOT}/big/SKILL.md`]: "x".repeat(64),
      [`${ROOT}/small`]: DIRECTORY,
      [`${ROOT}/small/SKILL.md`]: "y".repeat(16),
    });

    const result = await resolveRepoSkills(ROOT, BOUNDARY, reader, 32);

    expect(result.skills).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain("content size budget");
    expect(reader.reads).not.toContain(`${ROOT}/small`);
  });

  it("caps the number of entries and reports the overflow once", async () => {
    const entries: Record<string, string | typeof DIRECTORY> = { [ROOT]: DIRECTORY };
    for (let index = 0; index < 33; index += 1) {
      const name = `skill-${String(index).padStart(2, "0")}`;
      entries[`${ROOT}/${name}`] = DIRECTORY;
      entries[`${ROOT}/${name}/SKILL.md`] = "Body.\n";
    }

    const result = await resolveRepoSkills(ROOT, BOUNDARY, createMemoryReader(entries), BUDGET);

    expect(result.skills).toHaveLength(32);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain("32");
  });

  it("rejects a skill tree that exceeds the directory traversal limit", async () => {
    const entries: Record<string, string | typeof DIRECTORY> = {
      [ROOT]: DIRECTORY,
      [`${ROOT}/deep`]: DIRECTORY,
      [`${ROOT}/deep/SKILL.md`]: "Body.\n",
    };
    for (let index = 0; index < 200; index += 1) {
      entries[`${ROOT}/deep/directory-${String(index).padStart(3, "0")}`] = DIRECTORY;
    }

    const result = await resolveRepoSkills(ROOT, BOUNDARY, createMemoryReader(entries), BUDGET);

    expect(result.skills).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain("directory limit");
  });

  it("falls back to the directory name and defaults when frontmatter is absent", async () => {
    const reader = createMemoryReader({
      [ROOT]: DIRECTORY,
      [`${ROOT}/plain`]: DIRECTORY,
      [`${ROOT}/plain/SKILL.md`]: "Just a body.\n",
    });

    const result = await resolveRepoSkills(ROOT, BOUNDARY, reader, BUDGET);

    expect(result.skills[0]).toMatchObject({
      description: "Repository skill.",
      id: "plain",
      name: "plain",
      version: "0.0.0",
    });
  });

  it("refuses a skills directory symlinked outside .aura before listing it", async () => {
    const reader = createMemoryReader(
      {
        [BOUNDARY]: DIRECTORY,
        [ROOT]: DIRECTORY,
        [`${ROOT}/escaped`]: DIRECTORY,
        [`${ROOT}/escaped/SKILL.md`]: "Secret.\n",
      },
      { links: { [ROOT]: "/home/dev/private-skills" } },
    );

    const result = await resolveRepoSkills(ROOT, BOUNDARY, reader, BUDGET);

    expect(result.skills).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain("is not a directory");
    expect(reader.reads).toEqual([ROOT]);
  });
});
