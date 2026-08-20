import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPluginRegistry } from "@tryaura/core";

import type { WizardAnswers } from "./wizard-types.js";

import { consolidationPlugin } from "./testing-plugins.js";
import { cleanupFixtures, createFixture, snapshot } from "./testing.js";
import { runSetup } from "./setup.js";

afterEach(cleanupFixtures);

/**
 * What consolidation may take off disk.
 *
 * Archiving is unconditional, so the guard against losing text is the merge itself: a source is
 * archived because the target now holds what it said, never merely because it was selected.
 */
describe("consolidation archival", () => {
  it("keeps a source edited since the merge, and names it instead of archiving it", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.homeDir, ".claude"), { recursive: true });
    await writeFile(join(fixture.homeDir, ".claude", "CLAUDE.md"), "# Claude\n\nA.\n", "utf8");
    const rules = join(fixture.homeDir, ".windsurfrules");
    await writeFile(rules, "# Windsurf\n\nOriginal.\n", "utf8");
    const registry = createPluginRegistry([consolidationPlugin()], {
      bareCheckIdPlugins: ["checks-core"],
    });

    await expect(runSetup(fixture.request(registry))).resolves.toBe(0);
    await expect(lstat(rules)).rejects.toHaveProperty("code", "ENOENT");

    // Restored from the archive and then edited, which is the only way a source can carry a
    // heading the target already has while saying something the target does not.
    await writeFile(rules, "# Windsurf\n\nBrand new guidance.\n", "utf8");
    await expect(runSetup(fixture.request(registry, combine()))).resolves.toBe(0);

    await expect(readFile(rules, "utf8")).resolves.toContain("Brand new guidance.");
    expect(fixture.output()).toContain("changed since Aura merged it into");
    const shared = await readFile(join(fixture.homeDir, "agents", "AGENTS.md"), "utf8");
    expect(shared.match(/# Instructions from ~\/\.windsurfrules/gu)).toHaveLength(1);

    // Still convergent: the divergence stands until someone resolves it, and nothing else moves.
    const before = await snapshot(fixture.homeDir);
    await expect(runSetup(fixture.request(registry, combine()))).resolves.toBe(0);
    await expect(snapshot(fixture.homeDir)).resolves.toEqual(before);
  });

  it("archives a source restored unchanged, whose text the target already holds", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.homeDir, ".claude"), { recursive: true });
    await writeFile(join(fixture.homeDir, ".claude", "CLAUDE.md"), "# Claude\n\nA.\n", "utf8");
    const rules = join(fixture.homeDir, ".windsurfrules");
    const original = "# Windsurf\n\nOriginal.\n";
    await writeFile(rules, original, "utf8");
    const registry = createPluginRegistry([consolidationPlugin()], {
      bareCheckIdPlugins: ["checks-core"],
    });

    await expect(runSetup(fixture.request(registry))).resolves.toBe(0);
    await writeFile(rules, original, "utf8");

    await expect(runSetup(fixture.request(registry, combine()))).resolves.toBe(0);

    await expect(lstat(rules)).rejects.toHaveProperty("code", "ENOENT");
    const shared = await readFile(join(fixture.homeDir, "agents", "AGENTS.md"), "utf8");
    expect(shared.match(/# Instructions from ~\/\.windsurfrules/gu)).toHaveLength(1);
  });

  it("adds to a populated target on the answer it proposes, rather than rewriting it", async () => {
    const fixture = await createFixture();
    const shared = join(fixture.homeDir, "agents", "AGENTS.md");
    const original = "# Hand written\n\nKeep this.\n";
    await mkdir(join(fixture.homeDir, "agents"), { recursive: true });
    await mkdir(join(fixture.homeDir, ".claude"), { recursive: true });
    await writeFile(shared, original, "utf8");
    await writeFile(join(fixture.homeDir, ".claude", "CLAUDE.md"), "# Claude\n\nGlobal.\n", "utf8");
    const registry = createPluginRegistry([consolidationPlugin()], {
      bareCheckIdPlugins: ["checks-core"],
    });

    // No scripted answer: the menu's own proposal drives this run, which is what `--yes` takes.
    // Recommending a migration stays honest only while an unattended one cannot lose text.
    await expect(runSetup(fixture.request(registry))).resolves.toBe(0);

    const merged = await readFile(shared, "utf8");
    expect(merged.startsWith(original)).toBe(true);
    expect(merged).toContain("# Instructions from ~/.claude/CLAUDE.md");
  });
});

/** Picks `Combine found instructions`, the answer the action menu recommends and proposes. */
function combine(): readonly WizardAnswers[] {
  const answer: WizardAnswers = {
    "global-instruction-action": { kind: "options", values: ["consolidate"] },
  };
  return Array.from({ length: 8 }, () => answer);
}
