import { readFile } from "node:fs/promises";
import { join } from "node:path";

import officialContent from "@tryaura/content-official";
import { createSeedBuilder } from "@tryaura/aura-testkit";
import { describe, expect, it } from "vitest";

import { runCompiled } from "./binary-test-support.js";

/** Inside Aura's supported range, so the run plans instruction edits instead of downgrading them. */
const CLAUDE_VERSION = "2.1.5 (Claude Code)";

describe("compiled snippet content", () => {
  /**
   * Asserts what the run wrote rather than what it failed to say.
   *
   * A snippet the binary cannot read is reported as unavailable and then dropped, so a test written
   * as "the output never mentions this snippet" also passes when the snippets step never ran — and
   * it does not run without a detected application and a shared instruction file to splice into.
   * Selecting every source through a local preset makes the non-interactive binary read each
   * embedded asset. Comparing the appended text against this repository's Markdown proves the
   * bundled binary read the asset rather than something else shaped like it.
   */
  it("reads every embedded snippet during setup", async () => {
    const sources = await Promise.all(
      officialContent.snippets.map(async (snippet) => ({
        body: await readFile(new URL(snippet.source.url), "utf8"),
        id: snippet.id,
        version: snippet.version,
      })),
    );
    const selections = sources.map((source) => source.id);

    await using seed = await createSeedBuilder()
      .homeFile("agents/AGENTS.md", "# Shared agent instructions\n")
      .homeFile(
        "agents/aura.json",
        `${JSON.stringify(
          {
            apps: {},
            mcpServers: [],
            ownership: {},
            schemaVersion: 1,
            skills: [],
            snippets: [],
          },
          undefined,
          2,
        )}\n`,
      )
      .workspaceFile(
        "all-snippets.json",
        JSON.stringify({ name: "All snippets", schemaVersion: 1, snippets: selections }),
      )
      .shim("claude", [
        { args: ["--version"], stdout: `${CLAUDE_VERSION}\n` },
        { args: ["auth", "status"], stdout: '{"loggedIn":true}\n' },
      ])
      .build();

    const result = await runCompiled(
      seed,
      ["setup", "--yes", "--preset", join(seed.workspaceDir, "all-snippets.json")],
      { NO_COLOR: "1" },
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("is unavailable");
    expect(result.exitCode).toBe(0);
    const instructions = await readFile(join(seed.homeDir, "agents", "AGENTS.md"), "utf8");
    expect(instructions).not.toContain("<!-- aura:");
    for (const source of sources) {
      expect(instructions, source.id).toContain(source.body.trim());
    }
  });
});
