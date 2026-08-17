import type { AdapterFileSpec } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { buildWorkspaceModel } from "../index.js";
import {
  createMemoryReader,
  createSnapshot,
  createTestAdapter,
  createTestEnvironment,
  DIRECTORY,
} from "./testing.js";

const SKILLS: AdapterFileSpec = {
  id: "skills",
  kind: "skills",
  path: "/home/dev/.claude/skills",
  scope: "global",
};

const REQUIRED: AdapterFileSpec = {
  id: "config",
  kind: "config",
  path: "/home/dev/.codex/config.toml",
  scope: "global",
};

/** A second adapter, so a guard test can show the scan continuing past the broken one. */
const working = createTestAdapter({ id: "working" });

describe("adapter file discovery", () => {
  it("discovers nested files over repeated calls and reads every spec once", async () => {
    const reviewDirectory: AdapterFileSpec = {
      id: "skill.review",
      kind: "skills",
      path: "/home/dev/.claude/skills/review",
      scope: "global",
    };
    const reviewManifest: AdapterFileSpec = {
      id: "skill.review.manifest",
      kind: "skills",
      path: "/home/dev/.claude/skills/review/SKILL.md",
      scope: "global",
    };
    const discoveryCalls: string[][] = [];
    const adapter = createTestAdapter({
      files: ({ files }) => {
        discoveryCalls.push([...files.keys()]);
        return [
          SKILLS,
          ...(files.get(SKILLS.id)?.entries?.includes("review") === true ? [reviewDirectory] : []),
          ...(files.get(reviewDirectory.id)?.entries?.includes("SKILL.md") === true
            ? [reviewManifest]
            : []),
        ];
      },
      parse: ({ files }) =>
        createSnapshot({
          metadata: { manifest: files.get(reviewManifest.id)?.content ?? "" },
        }),
    });
    const reader = createMemoryReader({
      "/home/dev/.claude/skills": DIRECTORY,
      "/home/dev/.claude/skills/review": DIRECTORY,
      "/home/dev/.claude/skills/review/SKILL.md": "# Review",
    });

    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createTestEnvironment(),
      reader,
    });

    expect(diagnostics).toEqual([]);
    expect(discoveryCalls).toEqual([
      [],
      ["skills"],
      ["skills", "skill.review"],
      ["skills", "skill.review", "skill.review.manifest"],
    ]);
    expect(reader.reads.filter((path) => path.startsWith(SKILLS.path))).toEqual([
      SKILLS.path,
      reviewDirectory.path,
      reviewManifest.path,
    ]);
    expect(model.apps[0]?.sourceFiles.map(({ spec }) => spec.id)).toEqual([
      "skills",
      "skill.review",
      "skill.review.manifest",
    ]);
    expect(model.apps[0]?.metadata).toEqual({ manifest: "# Review" });
  });

  it("rejects duplicate file spec ids returned in one discovery round", async () => {
    const broken = createTestAdapter({ files: () => [REQUIRED, REQUIRED], id: "broken" });

    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [broken, working],
      environment: createTestEnvironment(),
      reader: createMemoryReader(),
    });

    expect(model.apps.map((app) => app.adapterId)).toEqual(["working"]);
    expect(diagnostics[0]).toMatchObject({ adapterId: "broken", phase: "files" });
    expect(diagnostics[0]?.detail).toContain('duplicate file spec id "config"');
  });

  it("rejects a file spec id redefined after an earlier read", async () => {
    const broken = createTestAdapter({
      files: ({ files }) =>
        files.size === 0 ? [REQUIRED] : [{ ...REQUIRED, path: `${REQUIRED.path}.other` }],
      id: "broken",
    });

    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [broken],
      environment: createTestEnvironment(),
      reader: createMemoryReader({ [REQUIRED.path]: "model = 'gpt'" }),
    });

    expect(model.apps).toEqual([]);
    expect(diagnostics[0]).toMatchObject({ adapterId: "broken", phase: "files" });
    expect(diagnostics[0]?.detail).toContain('redeclared file spec id "config"');
  });

  it("guards a file declaration that throws in a later discovery round", async () => {
    const broken = createTestAdapter({
      files: ({ files }) => {
        if (files.size > 0) {
          throw new Error("could not expand config");
        }
        return [REQUIRED];
      },
      id: "broken",
    });

    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [broken, working],
      environment: createTestEnvironment(),
      reader: createMemoryReader({ [REQUIRED.path]: "model = 'gpt'" }),
    });

    expect(model.apps.map((app) => app.adapterId)).toEqual(["working"]);
    expect(diagnostics[0]).toMatchObject({
      adapterId: "broken",
      detail: "could not expand config",
      phase: "files",
    });
  });

  it("stops file discovery that does not stabilize within sixteen rounds", async () => {
    const broken = createTestAdapter({
      files: ({ files }) => [
        {
          ...REQUIRED,
          id: `config.${files.size}`,
          optional: true,
          path: `${REQUIRED.path}.${files.size}`,
        },
      ],
      id: "broken",
    });

    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [broken],
      environment: createTestEnvironment(),
      reader: createMemoryReader(),
    });

    expect(model.apps).toEqual([]);
    expect(diagnostics[0]).toMatchObject({ adapterId: "broken", phase: "files" });
    expect(diagnostics[0]?.detail).toContain("did not stabilize within 16 rounds");
  });

  it("rejects more than ten thousand file specs before reading them", async () => {
    const specs = Array.from({ length: 10_001 }, (_, index): AdapterFileSpec => ({
      ...REQUIRED,
      id: `config.${index}`,
      optional: true,
      path: `${REQUIRED.path}.${index}`,
    }));
    const reader = createMemoryReader();
    const broken = createTestAdapter({ files: () => specs, id: "broken" });

    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [broken],
      environment: createTestEnvironment(),
      reader,
    });

    expect(model.apps).toEqual([]);
    expect(reader.reads.filter((path) => path.startsWith(REQUIRED.path))).toEqual([]);
    expect(diagnostics[0]).toMatchObject({ adapterId: "broken", phase: "files" });
    expect(diagnostics[0]?.detail).toContain("more than 10000 file specs");
  });
});
