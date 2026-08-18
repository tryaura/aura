import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { SkillPack } from "@tryaura/aura-sdk";
import { afterEach, describe, expect, it } from "vitest";

import type { RegisteredSkillPack } from "../plugin-registry.js";
import { createFileReader } from "./reader.js";
import { createMemoryReader, DIRECTORY } from "./testing.js";
import { resolveBundledSkills, scanSharedSkills, treeHash } from "./skills.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("bundled skill resolution", () => {
  it("resolves recursive UTF-8 assets and computes a stable portable tree hash", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "references"));
    await writeFile(join(root, "SKILL.md"), "---\nname: review\n---\n# Review\n", "utf8");
    await writeFile(join(root, "references", "guide.md"), "Guide\n", "utf8");

    const result = await resolveBundledSkills([registration(root)], createFileReader());

    expect(result.diagnostics).toEqual([]);
    expect(result.skills[0]).toMatchObject({
      id: "review",
      source: { id: "plugin:fixture", kind: "bundled" },
      version: "1.2.3",
    });
    expect(result.skills[0]?.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "references/guide.md",
    ]);
    expect(result.skills[0]?.treeHash).toBe(
      treeHash([
        { content: "Guide\n", path: "references\\guide.md" },
        { content: "---\nname: review\n---\n# Review\n", path: "SKILL.md" },
      ]),
    );
  });

  it("rejects the entire pack when SKILL.md is missing", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "README.md"), "No skill\n", "utf8");

    const result = await resolveBundledSkills([registration(root)], createFileReader());

    expect(result.skills).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain("does not contain SKILL.md");
  });

  it("rejects the entire pack when it contains a symbolic link", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "SKILL.md"), "---\nname: review\n---\n", "utf8");
    await writeFile(join(root, "outside.md"), "outside\n", "utf8");
    await symlink(join(root, "outside.md"), join(root, "linked.md"));

    const result = await resolveBundledSkills([registration(root)], createFileReader());

    expect(result.skills).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain("linked.md is a symbolic link");
  });

  it("rejects the entire pack when a file is not valid UTF-8", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "SKILL.md"), "---\nname: review\n---\n", "utf8");
    await writeFile(join(root, "binary.dat"), Buffer.from([0xff, 0xfe, 0x00]));

    const result = await resolveBundledSkills([registration(root)], createFileReader());

    expect(result.skills).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain("binary.dat is not valid UTF-8");
  });

  it("accepts a valid UTF-8 replacement character", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "SKILL.md"), "---\nname: review\n---\nReplacement: �\n", "utf8");

    const result = await resolveBundledSkills([registration(root)], createFileReader());

    expect(result.diagnostics).toEqual([]);
    expect(result.skills).toHaveLength(1);
  });

  it.each(["denied", "unsupported"] as const)(
    "rejects the entire pack when a child read reports %s",
    async (problem) => {
      const root = "/fixture/review";
      const reader = createMemoryReader(
        {
          [root]: DIRECTORY,
          [`${root}/SKILL.md`]: "---\nname: review\n---\n",
          [`${root}/asset.md`]: "unreadable",
        },
        { problems: { [`${root}/asset.md`]: problem } },
      );

      const result = await resolveBundledSkills([registration(root)], reader);

      expect(result.skills).toEqual([]);
      expect(result.diagnostics[0]?.message).toContain(`asset.md could not be read (${problem})`);
    },
  );

  it("scans shared copies independently with entries and hashes", async () => {
    const home = await temporaryDirectory();
    const root = join(home, "agents", "skills", "review");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "SKILL.md"),
      "---\nname: review\ndescription: Review code.\n---\nSee [guide](references/guide.md).\nSee [missing](references/missing.md).\n",
      "utf8",
    );
    await mkdir(join(root, "references"));
    await writeFile(join(root, "references", "guide.md"), "Guide\n", "utf8");

    const skills = await scanSharedSkills({ homeDir: home }, createFileReader());

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      definitionStatus: "ready",
      description: "Review code.",
      id: "review",
      name: "review",
      path: root,
      references: [
        { path: join(root, "references", "guide.md"), valid: true },
        { path: join(root, "references", "missing.md"), valid: false },
      ],
    });
    expect(skills[0]?.entries.map((entry) => entry.kind)).toEqual([
      "directory",
      "file",
      "directory",
      "file",
    ]);
    expect(skills[0]?.treeHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("records the read problem that makes a shared copy unsafe to reconcile", async () => {
    const root = "/home/dev/agents/skills";
    const reader = createMemoryReader(
      {
        [root]: DIRECTORY,
        [`${root}/review`]: DIRECTORY,
        [`${root}/review/SKILL.md`]: "unreadable",
      },
      { problems: { [`${root}/review/SKILL.md`]: "denied" } },
    );

    const skills = await scanSharedSkills({ homeDir: "/home/dev" }, reader);

    expect(skills[0]).toMatchObject({
      definitionStatus: "unreadable",
      id: "review",
      problem: "denied",
    });
    expect(skills[0]?.treeHash).toBeUndefined();
  });
});

function registration(root: string): RegisteredSkillPack {
  const skill: SkillPack = {
    description: "Fixture skill.",
    id: "review",
    kind: "skill-pack",
    name: "Review",
    source: { type: "directory", url: pathToFileURL(root).href },
    version: "1.2.3",
  };
  return {
    skill,
    source: { id: "plugin:fixture", kind: "bundled", name: "Fixture" },
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "aura-skills-"));
  temporaryDirectories.push(path);
  return path;
}
