import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPluginRegistry } from "@tryaura/core";

import type { WizardAnswers, WizardIo } from "./wizard-types.js";

import { findingPlugin } from "../testing.js";
import { consolidationPlugin, projectConsolidationPlugin } from "./testing-plugins.js";
import { backupEntry, cleanupFixtures, createFixture, snapshot } from "./testing.js";
import { runSetup } from "./setup.js";

afterEach(cleanupFixtures);

describe("instruction consolidation setup", () => {
  it("automatically archives a messy home, deduplicates it, wires the app, and converges", async () => {
    const duplicate =
      "Always run the full verification suite before considering implementation complete.";
    const originals = {
      claude: `# Claude\n\n${duplicate}\n\nClaude only.\n`,
      cursor: `# Cursor\n\n${duplicate}\n\nCursor only.\n`,
      windsurf:
        "# Windsurf\n\nKeep the deployment checklist current for every production release.\n",
    };
    const fixture = await createFixture();
    await mkdir(join(fixture.homeDir, ".claude"), { recursive: true });
    await writeFile(join(fixture.homeDir, ".claude", "CLAUDE.md"), originals.claude, "utf8");
    await writeFile(join(fixture.homeDir, ".cursorrules"), originals.cursor, "utf8");
    await writeFile(join(fixture.homeDir, ".windsurfrules"), originals.windsurf, "utf8");
    const registry = createPluginRegistry([consolidationPlugin()], {
      bareCheckIdPlugins: ["checks-core"],
    });

    await expect(runSetup(fixture.request(registry))).resolves.toBe(0);

    const shared = await readFile(join(fixture.homeDir, "agents", "AGENTS.md"), "utf8");
    expect(shared).toContain("# Instructions from ~/.claude/CLAUDE.md");
    expect(shared).toContain("# Instructions from ~/.cursorrules");
    expect(shared).toContain("# Instructions from ~/.windsurfrules");
    expect(shared).not.toContain(fixture.homeDir);
    expect(shared.match(new RegExp(duplicate, "gu"))).toHaveLength(1);
    const entry = await backupEntry(fixture.homeDir);
    await expect(
      readFile(join(entry, "consolidation", "home", ".claude", "CLAUDE.md"), "utf8"),
    ).resolves.toBe(originals.claude);
    await expect(
      readFile(join(entry, "consolidation", "home", ".cursorrules"), "utf8"),
    ).resolves.toBe(originals.cursor);
    await expect(
      readFile(join(fixture.homeDir, ".claude", "CLAUDE.md"), "utf8"),
    ).resolves.toContain("@~/agents/AGENTS.md");
    await expect(lstat(join(fixture.homeDir, ".cursorrules"))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );

    const before = await snapshot(fixture.homeDir);
    await expect(runSetup(fixture.request(registry))).resolves.toBe(0);
    await expect(snapshot(fixture.homeDir)).resolves.toEqual(before);
  });

  it("merges byte-identical files silently into one section under one heading", async () => {
    const content =
      "Always run the full verification suite before considering implementation complete.\n";
    const fixture = await createFixture();
    await mkdir(join(fixture.homeDir, ".claude"), { recursive: true });
    await writeFile(join(fixture.homeDir, ".claude", "CLAUDE.md"), content, "utf8");
    await writeFile(join(fixture.homeDir, ".cursorrules"), content, "utf8");
    const registry = createPluginRegistry([consolidationPlugin()], {
      bareCheckIdPlugins: ["checks-core"],
    });

    await expect(runSetup(fixture.request(registry))).resolves.toBe(0);

    // The copy that lost everything must not leave a dangling provenance heading behind.
    const shared = await readFile(join(fixture.homeDir, "agents", "AGENTS.md"), "utf8");
    expect(shared).toContain("# Instructions from ~/.claude/CLAUDE.md");
    expect(shared).not.toContain("# Instructions from ~/.cursorrules");
    expect(shared.match(/# Instructions from/gu)).toHaveLength(1);
    expect(shared.match(/Always run the full verification suite/gu)).toHaveLength(1);

    const before = await snapshot(fixture.homeDir);
    await expect(runSetup(fixture.request(registry))).resolves.toBe(0);
    await expect(snapshot(fixture.homeDir)).resolves.toEqual(before);
  });

  it("completes migration on the default answers without leaving duplicate warnings", async () => {
    const duplicate = "Always run the full verification suite before considering work complete.";
    const fixture = await createFixture();
    await mkdir(join(fixture.homeDir, ".claude"), { recursive: true });
    await writeFile(
      join(fixture.homeDir, ".claude", "CLAUDE.md"),
      `# Claude\n\n${duplicate}\n`,
      "utf8",
    );
    await writeFile(join(fixture.homeDir, ".cursorrules"), `# Cursor\n\n${duplicate}\n`, "utf8");
    const registry = createPluginRegistry([consolidationPlugin()], {
      bareCheckIdPlugins: ["checks-core"],
    });

    await expect(runSetup(fixture.request(registry))).resolves.toBe(0);

    // Consolidation is a migration: the legacy file is archived and the app entry becomes a link.
    await expect(lstat(join(fixture.homeDir, ".cursorrules"))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
    await expect(
      readFile(join(fixture.homeDir, ".claude", "CLAUDE.md"), "utf8"),
    ).resolves.toContain("@~/agents/AGENTS.md");
    const shared = await readFile(join(fixture.homeDir, "agents", "AGENTS.md"), "utf8");
    // `~/.cursorrules` loses its only paragraph to the copy kept under CLAUDE.md's heading, and its
    // surviving `# Cursor` line is not content the file contributed. Same rule as the byte-identical
    // case above, which held before only because those fixtures carried no heading to leave behind.
    expect(shared).not.toContain("# Instructions from ~/.cursorrules");
    expect(shared.match(/# Instructions from/gu)).toHaveLength(1);
    expect(shared.match(new RegExp(duplicate, "gu"))).toHaveLength(1);

    // Re-running must not merge the same sources into the target a second time.
    const before = await snapshot(fixture.homeDir);
    await expect(runSetup(fixture.request(registry))).resolves.toBe(0);
    await expect(snapshot(fixture.homeDir)).resolves.toEqual(before);
  });

  it("leaves observed project instructions byte-identical", async () => {
    const fixture = await createFixture();
    const project = join(fixture.workspace, "CLAUDE.md");
    const original = "# Project\n\nUse the repository verification command.\n";
    await writeFile(project, original, "utf8");
    const registry = createPluginRegistry(
      [projectConsolidationPlugin(), findingPlugin("info", [])],
      {},
    );

    const before = await snapshot(fixture.workspace);
    await expect(runSetup(fixture.request(registry))).resolves.toBe(0);

    await expect(readFile(project, "utf8")).resolves.toBe(original);
    await expect(readFile(join(fixture.workspace, "AGENTS.md"), "utf8")).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
    await expect(snapshot(fixture.workspace)).resolves.toEqual(before);
  });

  it("reports the state instead of asking when the target is already the only instruction file", async () => {
    const fixture = await createFixture();
    const shared = join(fixture.homeDir, "agents", "AGENTS.md");
    const original = "# Hand written\n\nKeep this.\n";
    await mkdir(join(fixture.homeDir, "agents"), { recursive: true });
    await writeFile(shared, original, "utf8");
    const registry = createPluginRegistry([consolidationPlugin()], {
      bareCheckIdPlugins: ["checks-core"],
    });
    const request = fixture.request(registry);
    const asked: string[] = [];
    const io: WizardIo = {
      ...request.io,
      ask: async (questions, flow) => {
        asked.push(...questions.map((question) => question.id));
        return request.io.ask(questions, flow);
      },
    };

    await expect(runSetup({ ...request, io })).resolves.toBe(0);

    // Neither answer the menu could carry is a decision left to make, so the form never opens.
    expect(asked).not.toContain("global-instruction-action");
    expect(fixture.output()).toMatch(
      /Personal instructions already live in \S*[/\\]agents[/\\]AGENTS\.md \(3 lines\); Aura found nothing else to consolidate and leaves the file as it is\./u,
    );
    // Settling on "keep" is not settling for nothing: the application still gets its link.
    await expect(readFile(shared, "utf8")).resolves.toBe(original);
    await expect(
      readFile(join(fixture.homeDir, ".claude", "CLAUDE.md"), "utf8"),
    ).resolves.toContain("@~/agents/AGENTS.md");
  });

  it("ignores an opt-out answered for a scope the menu never offered it on", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.homeDir, ".claude"), { recursive: true });
    await writeFile(join(fixture.homeDir, ".claude", "CLAUDE.md"), "# Claude\n\nGlobal.\n", "utf8");
    const registry = createPluginRegistry([consolidationPlugin()], {
      bareCheckIdPlugins: ["checks-core"],
    });

    await expect(runSetup(fixture.request(registry, skipGlobalInstructions()))).resolves.toBe(0);

    // Falls back to the first offered action instead of declining a scope that cannot be declined.
    await expect(readFile(join(fixture.homeDir, "agents", "AGENTS.md"), "utf8")).resolves.toContain(
      "# Instructions from ~/.claude/CLAUDE.md",
    );
  });
});

/** Repeated per form the flow may open, since scripted answers are consumed one form at a time. */
function repeatedAnswers(answer: WizardAnswers): readonly WizardAnswers[] {
  return Array.from({ length: 8 }, () => answer);
}

function skipGlobalInstructions(): readonly WizardAnswers[] {
  return repeatedAnswers({ "global-instruction-action": { kind: "options", values: ["skip"] } });
}
