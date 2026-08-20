import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPluginRegistry, hashContent } from "@tryaura/core";

import { runSetup } from "./setup.js";
import { manifestIds, manifestSnippetHashes, snippet, snippetPlugin } from "./snippet-testing.js";
import { cleanupFixtures, createFixture, snapshot } from "./testing.js";
import type { WizardAnswers } from "./wizard-types.js";

afterEach(cleanupFixtures);

describe("snippet setup integration", () => {
  it("appends snippets once without markers and never removes an unchecked install", async () => {
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
      runSetup(fixture.request(registry, answers(["fixture/alpha"], true))),
    ).resolves.toBe(0);
    const sharedPath = join(fixture.homeDir, "agents", "AGENTS.md");
    const installed = await readFile(sharedPath, "utf8");
    expect(installed).toContain("Use alpha.\n");
    expect(installed).not.toContain("aura:begin");
    expect(await manifestIds(fixture.homeDir)).toEqual(["fixture/alpha"]);

    await expect(runSetup(fixture.request(registry, answers(["fixture/alpha"])))).resolves.toBe(0);
    await expect(readFile(sharedPath, "utf8")).resolves.toBe(installed);
    expect(await manifestIds(fixture.homeDir)).toEqual(["fixture/alpha"]);

    const edited = installed.replace("Use alpha.", "Use alpha my way.");
    await writeFile(sharedPath, edited, "utf8");
    await expect(
      runSetup(fixture.request(registry, answers(["fixture/alpha", "fixture/beta"]))),
    ).resolves.toBe(0);
    const extended = await readFile(sharedPath, "utf8");
    expect(extended).toBe(`${edited.trimEnd()}\n\nUse beta.\n`);
    expect(extended.match(/Use alpha my way\./gu)).toHaveLength(1);
    expect(extended.match(/Use beta\./gu)).toHaveLength(1);
    expect(await manifestIds(fixture.homeDir)).toEqual(["fixture/alpha", "fixture/beta"]);

    const converged = await snapshot(fixture.homeDir);
    await expect(
      runSetup(fixture.request(registry, answers(["fixture/alpha", "fixture/beta"]))),
    ).resolves.toBe(0);
    await expect(snapshot(fixture.homeDir)).resolves.toEqual(converged);
  });

  it("keeps unavailable and manually deleted snippets installed in the manifest", async () => {
    const fixture = await createFixture();
    const sourcePath = join(fixture.workspace, "rules.md");
    await writeFile(sourcePath, "Keep this rule.\n", "utf8");
    const registry = createPluginRegistry([
      snippetPlugin([snippet("fixture/rules", sourcePath, "general", "Rules")]),
    ]);
    await expect(
      runSetup(fixture.request(registry, answers(["fixture/rules"], true))),
    ).resolves.toBe(0);

    const sharedPath = join(fixture.homeDir, "agents", "AGENTS.md");
    const replacement = "# Shared agent instructions\n\nThe installed text was removed manually.\n";
    await writeFile(sharedPath, replacement, "utf8");
    const withoutSnippet = createPluginRegistry([snippetPlugin([])]);
    await expect(
      runSetup(fixture.request(withoutSnippet, answers(["fixture/rules"]))),
    ).resolves.toBe(0);

    await expect(readFile(sharedPath, "utf8")).resolves.toBe(replacement);
    expect(await manifestIds(fixture.homeDir)).toEqual(["fixture/rules"]);
  });

  it("does not update an installed snippet when its plugin content changes", async () => {
    const fixture = await createFixture();
    const sourcePath = join(fixture.workspace, "rules.md");
    await writeFile(sourcePath, "Version one.\n", "utf8");
    const initial = createPluginRegistry([
      snippetPlugin([snippet("fixture/rules", sourcePath, "general", "Rules")]),
    ]);
    await expect(
      runSetup(fixture.request(initial, answers(["fixture/rules"], true))),
    ).resolves.toBe(0);
    const before = await snapshot(fixture.homeDir);

    await writeFile(sourcePath, "Version two.\n", "utf8");
    const changed = createPluginRegistry([
      snippetPlugin([
        { ...snippet("fixture/rules", sourcePath, "general", "Rules"), version: "2.0.0" },
      ]),
    ]);
    await expect(runSetup(fixture.request(changed, answers(["fixture/rules"])))).resolves.toBe(0);

    await expect(snapshot(fixture.homeDir)).resolves.toEqual(before);
  });

  it("migrates legacy manifest objects to ids while leaving marked text untouched", async () => {
    const fixture = await createFixture();
    const agents = join(fixture.homeDir, "agents");
    const sharedPath = join(agents, "AGENTS.md");
    const manifestPath = join(agents, "aura.json");
    const newPath = join(fixture.workspace, "new.md");
    const legacy = [
      "# Shared agent instructions",
      "",
      "<!-- aura:begin -->",
      "Managed by Aura. Edit via the Aura CLI; manual edits to this block are overwritten.",
      `<!-- aura:begin id=fixture/legacy sha256=${"a".repeat(64)} -->`,
      "Legacy rules.",
      "<!-- aura:end id=fixture/legacy -->",
      "<!-- aura:end -->",
      "",
    ].join("\n");
    await mkdir(agents, { recursive: true });
    await writeFile(sharedPath, legacy, "utf8");
    await writeFile(newPath, "New rules.\n", "utf8");
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        apps: {},
        mcpServers: [],
        ownership: {},
        schemaVersion: 1,
        skills: [],
        snippets: [
          {
            hash: "a".repeat(64),
            id: "fixture/legacy",
            pinned: false,
            version: "1.0.0",
          },
        ],
      })}\n`,
      "utf8",
    );
    const registry = createPluginRegistry([
      snippetPlugin([
        snippet("fixture/legacy", newPath, "general", "Legacy"),
        snippet("fixture/new", newPath, "general", "New"),
      ]),
    ]);

    await expect(
      runSetup(fixture.request(registry, answers(["fixture/legacy", "fixture/new"]))),
    ).resolves.toBe(0);

    await expect(readFile(sharedPath, "utf8")).resolves.toBe(`${legacy.trimEnd()}\n\nNew rules.\n`);
    expect(await manifestIds(fixture.homeDir)).toEqual(["fixture/legacy", "fixture/new"]);
  });

  it("keeps the record and the text when a later run leaves the row out of its answer", async () => {
    const fixture = await createFixture();
    const sourcePath = join(fixture.workspace, "rules.md");
    await writeFile(sourcePath, "Keep this rule.\n", "utf8");
    const registry = createPluginRegistry([
      snippetPlugin([snippet("fixture/rules", sourcePath, "general", "Rules")]),
    ]);
    await expect(
      runSetup(fixture.request(registry, answers(["fixture/rules"], true))),
    ).resolves.toBe(0);
    const sharedPath = join(fixture.homeDir, "agents", "AGENTS.md");
    const installed = await readFile(sharedPath, "utf8");

    await expect(runSetup(fixture.request(registry, answers([])))).resolves.toBe(0);
    await expect(readFile(sharedPath, "utf8")).resolves.toBe(installed);
    expect(await manifestIds(fixture.homeDir)).toEqual(["fixture/rules"]);

    // Still recorded, so a run that ticks it again is a no-op rather than a second copy.
    await expect(runSetup(fixture.request(registry, answers(["fixture/rules"])))).resolves.toBe(0);
    expect(await manifestIds(fixture.homeDir)).toEqual(["fixture/rules"]);
    expect((await readFile(sharedPath, "utf8")).match(/Keep this rule\./gu)).toHaveLength(1);
  });

  it("installs what it can when a preset also names a snippet no plugin provides", async () => {
    const fixture = await createFixture();
    const sourcePath = join(fixture.workspace, "rules.md");
    await writeFile(sourcePath, "Keep this rule.\n", "utf8");
    const registry = createPluginRegistry([
      snippetPlugin([snippet("fixture/rules", sourcePath, "general", "Rules")]),
    ]);

    await expect(
      runSetup(fixture.request(registry, answers(["fixture/rules", "ghost/rules"], true))),
    ).resolves.toBe(0);

    const sharedPath = join(fixture.homeDir, "agents", "AGENTS.md");
    await expect(readFile(sharedPath, "utf8")).resolves.toContain("Keep this rule.\n");
    expect(await manifestIds(fixture.homeDir)).toEqual(["fixture/rules"]);
  });

  it("records a fingerprint of the text it appended", async () => {
    const fixture = await createFixture();
    const sourcePath = join(fixture.workspace, "rules.md");
    await writeFile(sourcePath, "Keep this rule.\n", "utf8");
    const registry = createPluginRegistry([
      snippetPlugin([snippet("fixture/rules", sourcePath, "general", "Rules")]),
    ]);

    await expect(
      runSetup(fixture.request(registry, answers(["fixture/rules"], true))),
    ).resolves.toBe(0);

    const hashes = await manifestSnippetHashes(fixture.homeDir);
    expect(hashes.get("fixture/rules")).toBe(hashContent("Keep this rule.\n"));
  });

  it("uses the target line ending for newly appended snippets", async () => {
    const fixture = await createFixture();
    const agents = join(fixture.homeDir, "agents");
    const sharedPath = join(agents, "AGENTS.md");
    const sourcePath = join(fixture.workspace, "rules.md");
    await mkdir(agents, { recursive: true });
    await writeFile(sharedPath, "# Existing\r\n\r\nKeep this.\r\n", "utf8");
    await writeFile(sourcePath, "First.\nSecond.\n", "utf8");
    const registry = createPluginRegistry([
      snippetPlugin([snippet("fixture/rules", sourcePath, "general", "Rules")]),
    ]);

    await expect(runSetup(fixture.request(registry, answers(["fixture/rules"])))).resolves.toBe(0);

    await expect(readFile(sharedPath, "utf8")).resolves.toBe(
      "# Existing\r\n\r\nKeep this.\r\n\r\nFirst.\r\nSecond.\r\n",
    );
  });
});

/**
 * Every row left ticked when the picker closes, which is what the wizard actually returns.
 *
 * Installed rows open ticked and locked, so omitting one here says nothing: the record stands
 * either way. First setup asks for an instruction action before the picker.
 */
function answers(ticked: readonly string[], firstRun = false): readonly WizardAnswers[] {
  const snippets: WizardAnswers = { snippets: { kind: "options", values: ticked } };
  return firstRun ? [{}, snippets, {}] : [snippets];
}
