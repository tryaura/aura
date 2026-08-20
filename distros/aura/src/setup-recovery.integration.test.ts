import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  claudeCodeShimResponses,
  codexShimResponses,
  createSeedBuilder,
  runSetup,
  type TestSeed,
} from "@tryaura/aura-testkit";
import { describe, expect, it } from "vitest";

import { AURA_DISTRO } from "./distro.js";

/*
 * End to end over the real adapters: a first run consolidates and wires the applications, then the
 * manifest is replaced with the shape the boot-time repository-preset trust recorder writes when no
 * manifest exists — empty ownership — and the shared file is reset to the starter template. That is
 * the state a blocked earlier run leaves behind, and the next run must converge from it without
 * merging Aura's own managed block or the Codex symlink back into the shared file.
 */
describe("aura setup recovery", () => {
  it("re-converges after the manifest loses ownership of the wired links", async () => {
    await using seed = await createRecoverySeed();
    const sharedPath = join(seed.homeDir, "agents", "AGENTS.md");
    const codexEntry = join(seed.homeDir, ".codex", "AGENTS.md");
    const claudeEntry = join(seed.homeDir, ".claude", "CLAUDE.md");

    const first = await runSetup({ distro: AURA_DISTRO, seed });
    expect(first.exitCode, first.stdout).toBe(0);
    expect((await lstat(codexEntry)).isSymbolicLink()).toBe(true);
    expect((await lstat(claudeEntry)).isSymbolicLink()).toBe(true);
    await expect(readFile(claudeEntry, "utf8")).resolves.toContain(
      "# Instructions from ~/.claude/CLAUDE.md",
    );

    await writeFile(
      join(seed.homeDir, "agents", "aura.json"),
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
      "utf8",
    );
    await writeFile(sharedPath, "# Shared agent instructions\n", "utf8");

    const second = await runSetup({ distro: AURA_DISTRO, seed });
    expect(second.exitCode, second.stdout).toBe(0);
    expect(second.stdout).not.toContain("is not recorded in Aura's manifest");

    const shared = await readFile(sharedPath, "utf8");
    expect(shared).not.toContain("aura:begin");
    expect(shared).not.toContain("@~/agents/AGENTS.md");
    expect((await lstat(codexEntry)).isSymbolicLink()).toBe(true);
    const manifest: unknown = JSON.parse(
      await readFile(join(seed.homeDir, "agents", "aura.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      ownership: {
        "claude-code": { files: [expect.stringMatching(/\.claude\/CLAUDE\.md$/u)] },
        codex: { files: [expect.stringMatching(/\.codex\/AGENTS\.md$/u)] },
      },
    });

    const third = await runSetup({ distro: AURA_DISTRO, seed });
    expect(third.exitCode, third.stdout).toBe(0);
    expect(third.stdout).toContain("Already converged — nothing to do.");
    expect(third.diffs).toEqual([]);
  });
});

/** Claude Code with user instructions to consolidate, Codex with nothing at its entry yet. */
function createRecoverySeed(): Promise<TestSeed> {
  return createSeedBuilder()
    .homeFile(
      ".claude/CLAUDE.md",
      ["# Global preferences", "", "Always run the verification suite.", ""].join("\n"),
    )
    .homeFile(".codex/config.toml", 'model = "gpt-5"\n')
    .shim("claude", claudeCodeShimResponses({ authenticated: true, version: "2.1.233" }))
    .shim("codex", codexShimResponses({ authenticated: true, version: "0.146.0" }))
    .build();
}
