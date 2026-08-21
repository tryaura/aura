import { describe, expect, it } from "vitest";

import { hashContent } from "../content-hash.js";
import { createMemoryReader, createTestEnvironment, DIRECTORY } from "../workspace/testing.js";
import { readRepoContent } from "./repo-content.js";
import { readRepoPreset } from "./repo-trust.js";

const AURA = "/workspace/.aura";
const PRESET_TEXT = JSON.stringify({ schemaVersion: 1 });
const PRESET = { schemaVersion: 1 } as const;

function fs(entries: Record<string, string | typeof DIRECTORY> = {}) {
  return createMemoryReader({
    "/workspace/.aura": DIRECTORY,
    "/workspace/.aura/preset.json": PRESET_TEXT,
    ...entries,
  });
}

describe("readRepoContent", () => {
  it("hashes a content-free repository exactly like the bare preset", async () => {
    const result = await readRepoContent(AURA, PRESET, PRESET_TEXT, fs());

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("expected ready");
    }
    expect(result.hash).toBe(hashContent(PRESET_TEXT));
    expect(result.contentSet).toEqual({ mcpServers: [], skills: [], snippets: [] });
  });

  it("parses snippets with frontmatter, sorts by id, and widens the hash", async () => {
    const reader = fs({
      "/workspace/.aura/snippets": DIRECTORY,
      "/workspace/.aura/snippets/b-style.md": "Style body.\n",
      "/workspace/.aura/snippets/a-commits.md":
        "---\nname: Commit style\ndescription: House commit rules.\n---\nCommit body.\n",
    });

    const result = await readRepoContent(AURA, PRESET, PRESET_TEXT, reader);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("expected ready");
    }
    expect(result.contentSet.snippets).toEqual([
      {
        body: "Commit body.\n",
        description: "House commit rules.",
        id: "repo/a-commits",
        name: "Commit style",
      },
      { body: "Style body.\n", id: "repo/b-style", name: "b-style" },
    ]);
    expect(result.hash).not.toBe(hashContent(PRESET_TEXT));
  });

  it("hashes identically across CRLF rewrites and changes on any body edit", async () => {
    const lf = await readRepoContent(
      AURA,
      PRESET,
      PRESET_TEXT,
      fs({
        "/workspace/.aura/snippets": DIRECTORY,
        "/workspace/.aura/snippets/one.md": "Alpha.\nBeta.\n",
      }),
    );
    const crlf = await readRepoContent(
      AURA,
      PRESET,
      PRESET_TEXT,
      fs({
        "/workspace/.aura/snippets": DIRECTORY,
        "/workspace/.aura/snippets/one.md": "Alpha.\r\nBeta.\r\n",
      }),
    );
    const edited = await readRepoContent(
      AURA,
      PRESET,
      PRESET_TEXT,
      fs({
        "/workspace/.aura/snippets": DIRECTORY,
        "/workspace/.aura/snippets/one.md": "Alpha.\nGamma.\n",
      }),
    );

    if (lf.status !== "ready" || crlf.status !== "ready" || edited.status !== "ready") {
      throw new Error("expected ready");
    }
    expect(crlf.hash).toBe(lf.hash);
    expect(edited.hash).not.toBe(lf.hash);
  });

  it("ignores dotfiles and non-Markdown entries", async () => {
    const result = await readRepoContent(
      AURA,
      PRESET,
      PRESET_TEXT,
      fs({
        "/workspace/.aura/snippets": DIRECTORY,
        "/workspace/.aura/snippets/.DS_Store": "junk",
        "/workspace/.aura/snippets/README.txt": "not a snippet",
        "/workspace/.aura/snippets/real.md": "Body.\n",
      }),
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("expected ready");
    }
    expect(result.contentSet.snippets.map((snippet) => snippet.id)).toEqual(["repo/real"]);
  });

  it.each([
    [
      "a non-kebab file name",
      { "/workspace/.aura/snippets/Bad Name.md": "Body.\n" },
      "not a kebab-case",
    ],
    [
      "a directory wearing .md",
      { "/workspace/.aura/snippets/dir.md": DIRECTORY },
      "not a readable UTF-8 file",
    ],
  ] as const)("fails closed on %s", async (_case, entries, fragment) => {
    const result = await readRepoContent(
      AURA,
      PRESET,
      PRESET_TEXT,
      fs({ "/workspace/.aura/snippets": DIRECTORY, ...entries }),
    );

    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") {
      throw new Error("expected invalid");
    }
    expect(result.diagnostics[0]?.message).toContain(fragment);
    expect(result.diagnostics[0]?.message).not.toContain("Bad Name");
  });

  it("fails closed on a snippet symlinked outside the .aura directory", async () => {
    const reader = createMemoryReader(
      {
        "/workspace/.aura": DIRECTORY,
        "/workspace/.aura/preset.json": PRESET_TEXT,
        "/workspace/.aura/snippets": DIRECTORY,
        "/workspace/.aura/snippets/leak.md": "should never be read",
      },
      { links: { "/workspace/.aura/snippets/leak.md": "/home/dev/.ssh/id_ed25519" } },
    );

    const result = await readRepoContent(AURA, PRESET, PRESET_TEXT, reader);

    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") {
      throw new Error("expected invalid");
    }
    expect(result.diagnostics[0]?.message).toContain("outside the repository's .aura directory");
  });

  it("fails closed on an oversized snippet", async () => {
    const result = await readRepoContent(
      AURA,
      PRESET,
      PRESET_TEXT,
      fs({
        "/workspace/.aura/snippets": DIRECTORY,
        "/workspace/.aura/snippets/big.md": "x".repeat(256_001),
      }),
    );

    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") {
      throw new Error("expected invalid");
    }
    expect(result.diagnostics[0]?.message).toContain("byte snippet limit");
  });

  it("fails closed when the snippet count exceeds the cap", async () => {
    const entries: Record<string, string> = {};
    for (let index = 0; index < 65; index += 1) {
      entries[`/workspace/.aura/snippets/snippet-${String(index)}.md`] = "Body.\n";
    }

    const result = await readRepoContent(
      AURA,
      PRESET,
      PRESET_TEXT,
      fs({ "/workspace/.aura/snippets": DIRECTORY, ...entries }),
    );

    expect(result.status).toBe("invalid");
  });

  it("resolves repository skills and passes provided MCP servers through", async () => {
    const preset = {
      provides: {
        mcpServers: [
          {
            credentialEnv: [],
            description: "Docs.",
            docsUrl: "https://docs.example.com",
            id: "repo/docs",
            name: "Docs",
            schemaVersion: 1,
            serverName: "repo-docs",
            transportTemplate: { command: "npx", type: "stdio" },
          },
        ],
      },
      schemaVersion: 1,
    } as const;
    const result = await readRepoContent(
      AURA,
      preset,
      PRESET_TEXT,
      fs({
        "/workspace/.aura/skills": DIRECTORY,
        "/workspace/.aura/skills/release-runbook": DIRECTORY,
        "/workspace/.aura/skills/release-runbook/SKILL.md":
          "---\nname: Release runbook\ndescription: Cut a release.\nversion: 1.2.0\n---\nSteps.\n",
        "/workspace/.aura/skills/release-runbook/steps.md": "1. Tag.\n",
      }),
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("expected ready");
    }
    expect(result.contentSet.mcpServers[0]?.id).toBe("repo/docs");
    const skill = result.contentSet.skills[0];
    expect(skill).toMatchObject({
      description: "Cut a release.",
      id: "release-runbook",
      name: "Release runbook",
      source: { id: "repo:workspace", kind: "repo", name: "This repository" },
      version: "1.2.0",
    });
    expect(skill?.treeHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(skill?.files.map((file) => file.path)).toEqual(["SKILL.md", "steps.md"]);
    // Skill trees stay outside the trust hash: offers, not consented bytes.
    expect(result.hash).toBe(hashContent(PRESET_TEXT));
  });

  it("drops a broken skill tree with a diagnostic instead of failing the run", async () => {
    const result = await readRepoContent(
      AURA,
      PRESET,
      PRESET_TEXT,
      fs({
        "/workspace/.aura/skills": DIRECTORY,
        "/workspace/.aura/skills/no-definition": DIRECTORY,
        "/workspace/.aura/skills/no-definition/notes.md": "No SKILL.md here.\n",
      }),
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("expected ready");
    }
    expect(result.contentSet.skills).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain("does not contain SKILL.md");
  });
});

describe("readRepoPreset with repository content", () => {
  it("returns the snapshot and the composite hash", async () => {
    const reader = fs({
      "/workspace/.aura/snippets": DIRECTORY,
      "/workspace/.aura/snippets/style.md": "Style body.\n",
    });

    const state = await readRepoPreset(createTestEnvironment(), reader);

    expect(state.status).toBe("ready");
    expect(state.contentSet?.snippets[0]?.id).toBe("repo/style");
    expect(state.hash).toBeDefined();
    expect(state.hash).not.toBe(hashContent(PRESET_TEXT));
  });

  it("fails the whole preset read when the snippet set is broken", async () => {
    const reader = fs({
      "/workspace/.aura/snippets": DIRECTORY,
      "/workspace/.aura/snippets/Bad Name.md": "Body.\n",
    });

    const state = await readRepoPreset(createTestEnvironment(), reader);

    expect(state.status).toBe("invalid");
    expect(state.hash).toBeUndefined();
    expect(state.contentSet).toBeUndefined();
  });
});
