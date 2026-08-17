import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPluginRegistry } from "@tryaura/core";

import { runSetup } from "./setup.js";
import { installedIds, manifestIds, snippet, snippetPlugin } from "./snippet-testing.js";
import { snippetsStep } from "./steps/snippets.js";
import { cleanupFixtures, createFixture, snapshot } from "./testing.js";

afterEach(cleanupFixtures);

describe("targeted snippet setup integration", () => {
  it("rejects the snippet step when shared instructions do not exist", async () => {
    const fixture = await createFixture();
    const registry = createPluginRegistry([]);
    const before = await snapshot(fixture.homeDir);

    await expect(runSetup({ ...fixture.request(registry), steps: [snippetsStep] })).resolves.toBe(
      2,
    );
    await expect(snapshot(fixture.homeDir)).resolves.toEqual(before);
  });

  it("changes only shared instructions plus the manifest", async () => {
    const fixture = await createFixture();
    const sharedPath = join(fixture.homeDir, "agents", "AGENTS.md");
    const manifestPath = join(fixture.homeDir, "agents", "aura.json");
    const sourcePath = join(fixture.workspace, "rules.md");
    await mkdir(join(fixture.homeDir, "agents"));
    await writeFile(sharedPath, "", "utf8");
    await writeFile(manifestPath, emptyManifest(), "utf8");
    await writeFile(sourcePath, "Targeted rules.\n", "utf8");
    const registry = createPluginRegistry([
      snippetPlugin([snippet("fixture/targeted", sourcePath, "general", "Targeted")]),
    ]);
    const before = await snapshot(fixture.homeDir);

    await expect(
      runSetup({
        ...fixture.request(registry, [
          { snippets: { kind: "options", values: ["fixture/targeted"] } },
        ]),
        steps: [snippetsStep],
      }),
    ).resolves.toBe(0);

    const after = await snapshot(fixture.homeDir);
    expect(changedPaths(before, after)).toEqual(["agents/AGENTS.md", "agents/aura.json"]);
    expect(await installedIds(fixture.homeDir)).toEqual(["fixture/targeted"]);
    expect(await manifestIds(fixture.homeDir)).toEqual(["fixture/targeted"]);
  });

  it("rejects an unreadable shared-instructions path", async () => {
    const fixture = await createFixture();
    const sharedPath = join(fixture.homeDir, "agents", "AGENTS.md");
    await mkdir(sharedPath, { recursive: true });
    const registry = createPluginRegistry([]);
    const before = await snapshot(fixture.homeDir);

    await expect(runSetup({ ...fixture.request(registry), steps: [snippetsStep] })).resolves.toBe(
      2,
    );
    await expect(snapshot(fixture.homeDir)).resolves.toEqual(before);
  });
});

function emptyManifest(): string {
  return `${JSON.stringify(
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
  )}\n`;
}

function changedPaths(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): readonly string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => !path.startsWith("agents/.backups"))
    .filter((path) => before[path] !== after[path])
    .sort();
}
