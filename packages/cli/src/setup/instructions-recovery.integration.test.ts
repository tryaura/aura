import { lstat, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPluginRegistry } from "@tryaura/core";

import type { WizardAnswers } from "./wizard-types.js";

import { consolidationPlugin, symlinkConsolidationPlugin } from "./testing-plugins.js";
import { cleanupFixtures, createFixture, snapshot } from "./testing.js";
import { runSetup } from "./setup.js";

afterEach(cleanupFixtures);

/*
 * The damaged state a partially applied earlier run leaves behind: the link artifacts exist on
 * disk — an import-line entry holding Aura's managed block, a symlink at the Codex entry — but the
 * manifest was recreated by the boot-time trust recorder with an empty ownership ledger, and the
 * shared file holds only the starter template. Setup must converge from here without consuming its
 * own artifacts: no self-import merged into the shared file, no archive of the symlink, and the
 * ownership ledger repopulated by the first apply.
 */
describe("instruction consolidation recovery", () => {
  it("converges from link artifacts and an ownership-less manifest without self-merging", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.homeDir, ".claude"), { recursive: true });
    await writeFile(
      join(fixture.homeDir, ".claude", "CLAUDE.md"),
      "# Claude\n\nUser rule.\n",
      "utf8",
    );
    const registry = createPluginRegistry([consolidationPlugin(), symlinkConsolidationPlugin()], {
      bareCheckIdPlugins: ["checks-core"],
    });

    await expect(runSetup(fixture.request(registry))).resolves.toBe(0);
    const sharedPath = join(fixture.homeDir, "agents", "AGENTS.md");
    const entryPath = join(fixture.homeDir, ".codex", "AGENTS.md");
    expect((await lstat(entryPath)).isSymbolicLink()).toBe(true);

    // The damage: ownership gone, shared file back to the template.
    await writeFile(
      join(fixture.homeDir, "agents", "aura.json"),
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

    // Ask for consolidation the way the real interactive run did; with nothing genuine to offer,
    // the wizard settles on keeping the shared file rather than merging Aura's own artifacts.
    await expect(runSetup(fixture.request(registry, consolidateAnswers()))).resolves.toBe(0);

    expect(fixture.output()).not.toContain("is not recorded in Aura's manifest");
    const shared = await readFile(sharedPath, "utf8");
    expect(shared).not.toContain("aura:begin");
    expect(shared).not.toContain("@~/agents/AGENTS.md");
    expect((await lstat(entryPath)).isSymbolicLink()).toBe(true);
    const manifest: unknown = JSON.parse(
      await readFile(join(fixture.homeDir, "agents", "aura.json"), "utf8"),
    );
    // Suffix-matched: the recorded paths are canonical, and the macOS fixture home sits behind
    // the `/var` → `/private/var` symlink.
    expect(manifest).toMatchObject({
      ownership: {
        "fixture-agent": {
          files: [expect.stringMatching(/\/home\/\.claude\/CLAUDE\.md$/u)],
        },
        "symlink-agent": {
          files: [expect.stringMatching(/\/home\/\.codex\/AGENTS\.md$/u)],
        },
      },
    });

    const before = await snapshot(fixture.homeDir);
    await expect(runSetup(fixture.request(registry))).resolves.toBe(0);
    await expect(snapshot(fixture.homeDir)).resolves.toEqual(before);
  });
});

/** Consolidate with every offered source, repeated per form the flow may open. */
function consolidateAnswers(): readonly WizardAnswers[] {
  return Array.from({ length: 8 }, () => ({
    "global-instruction-action": { kind: "options", values: ["consolidate"] },
  }));
}
