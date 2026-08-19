import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { hashManagedSnippet } from "@tryaura/core";
import officialContent from "@tryaura/content-official";
import { createSeedBuilder } from "@tryaura/aura-testkit";
import type { AuraManifestSnippet } from "@tryaura/aura-sdk";
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
   * Seeding the selections as an existing manifest is what makes the step reach every embedded
   * source, and comparing the spliced text against this repository's own Markdown is what proves
   * the binary read the asset rather than something else shaped like it.
   */
  it("reads every embedded snippet during setup", async () => {
    const sources = await Promise.all(
      officialContent.snippets.map(async (snippet) => ({
        body: await readFile(new URL(snippet.source.url), "utf8"),
        id: snippet.id,
        version: snippet.version,
      })),
    );
    const selections = sources.map((source): AuraManifestSnippet => ({
      hash: hashManagedSnippet(source.body),
      id: source.id,
      pinned: false,
      version: source.version,
    }));

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
            snippets: selections,
          },
          undefined,
          2,
        )}\n`,
      )
      .shim("claude", [
        { args: ["--version"], stdout: `${CLAUDE_VERSION}\n` },
        { args: ["auth", "status"], stdout: '{"loggedIn":true}\n' },
      ])
      .build();

    const result = await runCompiled(seed, ["setup", "--yes"], { NO_COLOR: "1" });

    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("is unavailable");
    expect(result.exitCode).toBe(0);
    const instructions = await readFile(join(seed.homeDir, "agents", "AGENTS.md"), "utf8");
    for (const source of sources) {
      expect(instructions, source.id).toContain(source.body.trim());
    }
  });
});
