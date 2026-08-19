import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AURA_MANAGED_BLOCK_NOTICE,
  createPluginRegistry,
  hashManagedSnippet,
  reconcileManagedBlock,
  reconcileManagedSnippet,
} from "@tryaura/core";

import { runSetup } from "./setup.js";
import {
  installedIds,
  isRecord,
  manifestIds,
  manifestSnippets,
  snippet,
  snippetPlugin,
} from "./snippet-testing.js";
import { cleanupFixtures, createFixture, snapshot } from "./testing.js";
import type { WizardAnswers } from "./wizard-types.js";

afterEach(cleanupFixtures);

describe("snippet setup integration", () => {
  it("adds, removes, and reselects snippets cleanly across runs", async () => {
    const fixture = await createFixture();
    const alphaPath = join(fixture.workspace, "alpha.md");
    const betaPath = join(fixture.workspace, "beta.md");
    await writeFile(alphaPath, "Use alpha.\n", "utf8");
    await writeFile(betaPath, "Use beta.\n", "utf8");
    const registry = createPluginRegistry([
      snippetPlugin([
        snippet("fixture/alpha", alphaPath, "language", "Alpha"),
        snippet("fixture/beta", betaPath, "safety", "Beta"),
      ]),
    ]);

    await expect(
      runSetup(fixture.request(registry, answers(["fixture/alpha", "fixture/beta"], true))),
    ).resolves.toBe(0);
    expect(await installedIds(fixture.homeDir)).toEqual(["fixture/alpha", "fixture/beta"]);
    expect(await manifestIds(fixture.homeDir)).toEqual(["fixture/alpha", "fixture/beta"]);
    expect(await manifestSnippets(fixture.homeDir)).toEqual([
      {
        hash: "5b307c621c97384bd189626df59557631a7f54c465824ccb878428978db1fb25",
        id: "fixture/alpha",
        pinned: false,
        version: "1.0.0",
      },
      {
        hash: "a4cc94b6b00461d4df7539dc82076c848768f256749ad52550e3b870506c2cde",
        id: "fixture/beta",
        pinned: false,
        version: "1.0.0",
      },
    ]);

    await expect(runSetup(fixture.request(registry, answers(["fixture/beta"])))).resolves.toBe(0);
    expect(await installedIds(fixture.homeDir)).toEqual(["fixture/beta"]);
    expect(await manifestIds(fixture.homeDir)).toEqual(["fixture/beta"]);

    await expect(
      runSetup(fixture.request(registry, answers(["fixture/beta", "fixture/alpha"]))),
    ).resolves.toBe(0);
    expect(await installedIds(fixture.homeDir)).toEqual(["fixture/beta", "fixture/alpha"]);
    expect(await manifestIds(fixture.homeDir)).toEqual(["fixture/beta", "fixture/alpha"]);
    const converged = await snapshot(fixture.homeDir);

    await expect(
      runSetup(fixture.request(registry, answers(["fixture/beta", "fixture/alpha"]))),
    ).resolves.toBe(0);
    await expect(snapshot(fixture.homeDir)).resolves.toEqual(converged);
  });

  it("preserves an unavailable prior selection and blocks when its section is also missing", async () => {
    const fixture = await createFixture();
    const sourcePath = join(fixture.workspace, "rules.md");
    await writeFile(sourcePath, "Keep this rule.\n", "utf8");
    const registry = createPluginRegistry([
      snippetPlugin([snippet("fixture/rules", sourcePath, "general", "Rules")]),
    ]);
    await expect(
      runSetup(fixture.request(registry, answers(["fixture/rules"], true))),
    ).resolves.toBe(0);
    const before = await snapshot(fixture.homeDir);
    // The contributing plugin is gone, so the registry no longer offers the snippet at all.
    const withoutSnippet = createPluginRegistry([snippetPlugin([])]);

    await expect(
      runSetup(fixture.request(withoutSnippet, answers(["fixture/rules"]))),
    ).resolves.toBe(0);
    await expect(snapshot(fixture.homeDir)).resolves.toEqual(before);

    const sharedPath = join(fixture.homeDir, "agents", "AGENTS.md");
    await writeFile(sharedPath, "# Shared agent instructions\n", "utf8");
    await expect(
      runSetup(fixture.request(withoutSnippet, answers(["fixture/rules"]))),
    ).resolves.toBe(2);
  });

  it("drops an unavailable prior selection once it is cleared", async () => {
    const fixture = await createFixture();
    const sourcePath = join(fixture.workspace, "rules.md");
    await writeFile(sourcePath, "Keep this rule.\n", "utf8");
    const registry = createPluginRegistry([
      snippetPlugin([snippet("fixture/rules", sourcePath, "general", "Rules")]),
    ]);
    await expect(
      runSetup(fixture.request(registry, answers(["fixture/rules"], true))),
    ).resolves.toBe(0);
    const withoutSnippet = createPluginRegistry([snippetPlugin([])]);

    // Clearing the locked row is the only way out once the contributing plugin is gone.
    await expect(runSetup(fixture.request(withoutSnippet, answers([])))).resolves.toBe(0);

    expect(await installedIds(fixture.homeDir)).toEqual([]);
    expect(await manifestIds(fixture.homeDir)).toEqual([]);
  });

  it("reports a hand edit it is about to replace", async () => {
    const fixture = await createFixture();
    const sourcePath = join(fixture.workspace, "rules.md");
    await writeFile(sourcePath, "Rules.\n", "utf8");
    const registry = createPluginRegistry([
      snippetPlugin([snippet("fixture/rules", sourcePath, "general", "Rules")]),
    ]);
    await expect(
      runSetup(fixture.request(registry, answers(["fixture/rules"], true))),
    ).resolves.toBe(0);
    const sharedPath = join(fixture.homeDir, "agents", "AGENTS.md");
    const edited = (await readFile(sharedPath, "utf8")).replace("Rules.\n", "Rules, my way.\n");
    const restamped = reconcileManagedSnippet(edited, "fixture/rules", { kind: "keep" });
    await writeFile(sharedPath, restamped.content, "utf8");

    await expect(runSetup(fixture.request(registry, answers(["fixture/rules"])))).resolves.toBe(0);

    expect(fixture.output()).toContain(
      'Snippet "fixture/rules" was edited by hand since Aura wrote it; the edit is being replaced.',
    );
    await expect(readFile(sharedPath, "utf8")).resolves.toContain("Rules.\n");
  });

  it("preserves a kept pinned snippet across setup until it is deselected", async () => {
    const fixture = await createFixture();
    const sourcePath = join(fixture.workspace, "rules.md");
    await writeFile(sourcePath, "Registry rules.\n", "utf8");
    const registry = createPluginRegistry([
      snippetPlugin([snippet("fixture/rules", sourcePath, "general", "Rules")]),
    ]);
    await expect(
      runSetup(fixture.request(registry, answers(["fixture/rules"], true))),
    ).resolves.toBe(0);

    const sharedPath = join(fixture.homeDir, "agents", "AGENTS.md");
    const manifestPath = join(fixture.homeDir, "agents", "aura.json");
    const edited = (await readFile(sharedPath, "utf8")).replace(
      "Registry rules.\n",
      "Rules I kept.\n",
    );
    const kept = reconcileManagedSnippet(edited, "fixture/rules", { kind: "keep" });
    const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!isRecord(manifest) || !Array.isArray(manifest["snippets"])) {
      throw new Error("Expected manifest snippets.");
    }
    const selected = manifest["snippets"][0];
    if (!isRecord(selected)) {
      throw new Error("Expected one manifest snippet.");
    }
    selected["hash"] = hashManagedSnippet("Rules I kept.");
    selected["pinned"] = true;
    await Promise.all([
      writeFile(sharedPath, kept.content, "utf8"),
      writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, "utf8"),
    ]);
    const before = await snapshot(fixture.homeDir);

    await expect(runSetup(fixture.request(registry, answers(["fixture/rules"])))).resolves.toBe(0);
    await expect(snapshot(fixture.homeDir)).resolves.toEqual(before);

    const missingPinned = "# Shared agent instructions\n";
    await writeFile(sharedPath, missingPinned, "utf8");
    await expect(runSetup(fixture.request(registry, answers(["fixture/rules"])))).resolves.toBe(2);
    await expect(readFile(sharedPath, "utf8")).resolves.toBe(missingPinned);

    await writeFile(sharedPath, kept.content, "utf8");
    await expect(runSetup(fixture.request(registry, answers([])))).resolves.toBe(0);
    expect(await installedIds(fixture.homeDir)).toEqual([]);
    expect(await manifestIds(fixture.homeDir)).toEqual([]);
  });

  it("holds a newer source revision on a non-interactive run and says which one it held", async () => {
    // Holding is the safe default, but a run that holds silently is indistinguishable from a run
    // with nothing to do — exactly the reading a `--yes` run would get wrong.
    const fixture = await createFixture();
    const sourcePath = join(fixture.workspace, "rules.md");
    await writeFile(sourcePath, "Version one.\n", "utf8");
    const before = createPluginRegistry([
      snippetPlugin([snippet("fixture/rules", sourcePath, "general", "Rules")]),
    ]);
    await expect(runSetup(fixture.request(before, answers(["fixture/rules"], true)))).resolves.toBe(
      0,
    );

    const sharedPath = join(fixture.homeDir, "agents", "AGENTS.md");
    const installed = await readFile(sharedPath, "utf8");
    await writeFile(sourcePath, "Version two.\n", "utf8");
    const after = createPluginRegistry([
      snippetPlugin([
        { ...snippet("fixture/rules", sourcePath, "general", "Rules"), version: "2.0.0" },
      ]),
    ]);

    await expect(runSetup(fixture.request(after, answers(["fixture/rules"])))).resolves.toBe(0);

    await expect(readFile(sharedPath, "utf8")).resolves.toBe(installed);
    expect(await manifestSnippets(fixture.homeDir)).toMatchObject([{ version: "1.0.0" }]);
    expect(fixture.output()).toContain("Managed content kept at its recorded revision:");
    expect(fixture.output()).toContain("fixture/rules stays at 1.0.0; 2.0.0 is available.");
  });

  it("preserves and reports a tagged section absent from the manifest ledger", async () => {
    const fixture = await createFixture();
    const sourcePath = join(fixture.workspace, "owned.md");
    await writeFile(sourcePath, "Owned.\n", "utf8");
    const registry = createPluginRegistry([
      snippetPlugin([snippet("fixture/owned", sourcePath, "general", "Owned")]),
    ]);
    await expect(
      runSetup(fixture.request(registry, answers(["fixture/owned"], true))),
    ).resolves.toBe(0);
    const sharedPath = join(fixture.homeDir, "agents", "AGENTS.md");
    const existing = await readFile(sharedPath, "utf8");
    const withForeign = reconcileManagedBlock(existing, [
      { content: "Owned.\n", id: "fixture/owned" },
      { content: "Foreign.\n", id: "other/foreign" },
    ]);
    await writeFile(sharedPath, withForeign.content, "utf8");

    await expect(runSetup(fixture.request(registry, answers([])))).resolves.toBe(0);

    expect(await installedIds(fixture.homeDir)).toEqual(["other/foreign"]);
    expect(await manifestIds(fixture.homeDir)).toEqual([]);
  });

  it("blocks rather than relocating untagged content inside the managed block", async () => {
    const fixture = await createFixture();
    const sourcePath = join(fixture.workspace, "rules.md");
    await writeFile(sourcePath, "Rules.\n", "utf8");
    const registry = createPluginRegistry([
      snippetPlugin([snippet("fixture/rules", sourcePath, "general", "Rules")]),
    ]);
    await expect(
      runSetup(fixture.request(registry, answers(["fixture/rules"], true))),
    ).resolves.toBe(0);
    const sharedPath = join(fixture.homeDir, "agents", "AGENTS.md");
    const edited = (await readFile(sharedPath, "utf8")).replace(
      `${AURA_MANAGED_BLOCK_NOTICE}\n`,
      `${AURA_MANAGED_BLOCK_NOTICE}\nhandwritten inside\n`,
    );
    await writeFile(sharedPath, edited, "utf8");

    await expect(runSetup(fixture.request(registry, answers(["fixture/rules"])))).resolves.toBe(2);
    await expect(readFile(sharedPath, "utf8")).resolves.toBe(edited);
  });

  it("blocks setup when an unterminated fence hides the existing managed block", async () => {
    const fixture = await createFixture();
    const sourcePath = join(fixture.workspace, "rules.md");
    await writeFile(sourcePath, "Rules.\n", "utf8");
    const registry = createPluginRegistry([
      snippetPlugin([snippet("fixture/rules", sourcePath, "general", "Rules")]),
    ]);
    await expect(
      runSetup(fixture.request(registry, answers(["fixture/rules"], true))),
    ).resolves.toBe(0);
    const sharedPath = join(fixture.homeDir, "agents", "AGENTS.md");
    const hidden = `\`\`\`\n${await readFile(sharedPath, "utf8")}`;
    await writeFile(sharedPath, hidden, "utf8");

    await expect(runSetup(fixture.request(registry, answers(["fixture/rules"])))).resolves.toBe(2);
    await expect(readFile(sharedPath, "utf8")).resolves.toBe(hidden);
  });
});

function answers(selected: readonly string[], firstRun = false): readonly WizardAnswers[] {
  const instruction: WizardAnswers = {};
  const snippets: WizardAnswers = {
    snippets: { kind: "options", values: selected },
  };
  return firstRun ? [instruction, snippets, {}] : [instruction, snippets];
}
