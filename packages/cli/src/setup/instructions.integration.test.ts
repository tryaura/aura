import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPluginRegistry } from "@tryaura/core";

import type { WizardAnswers } from "./wizard-types.js";

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

  it("moves project guidance into project AGENTS.md and leaves a portable Claude link", async () => {
    const fixture = await createFixture();
    const source = join(fixture.workspace, "CLAUDE.md");
    await writeFile(source, "# Project\n\nUse the repository verification command.\n", "utf8");
    const registry = createPluginRegistry(
      [projectConsolidationPlugin(), findingPlugin("info", [])],
      {},
    );

    await expect(runSetup(fixture.request(registry))).resolves.toBe(0);

    // Repository-relative provenance: this file is committed, so an absolute path would publish
    // the developer's username and resolve to nothing on anyone else's checkout.
    const shared = await readFile(join(fixture.workspace, "AGENTS.md"), "utf8");
    expect(shared).toContain("# Instructions from CLAUDE.md");
    expect(shared).not.toContain(fixture.workspace);
    await expect(readFile(source, "utf8")).resolves.toContain("@./AGENTS.md");
  });

  it("consolidates the global scope while a skipped project scope stays byte-identical", async () => {
    const fixture = await createFixture();
    const project = join(fixture.workspace, "CLAUDE.md");
    const original = "# Project\n\nUse the repository verification command.\n";
    await writeFile(project, original, "utf8");
    await mkdir(join(fixture.homeDir, ".claude"), { recursive: true });
    await writeFile(join(fixture.homeDir, ".claude", "CLAUDE.md"), "# Claude\n\nGlobal.\n", "utf8");
    const registry = createPluginRegistry([consolidationPlugin(), projectConsolidationPlugin()], {
      bareCheckIdPlugins: ["checks-core"],
    });

    await expect(runSetup(fixture.request(registry, skipProjectInstructions()))).resolves.toBe(0);

    const shared = await readFile(join(fixture.homeDir, "agents", "AGENTS.md"), "utf8");
    expect(shared).toContain("# Instructions from ~/.claude/CLAUDE.md");
    // Declining the scope withholds the link as well as the target: a project CLAUDE.md carrying an
    // `@./AGENTS.md` import would point at a file this run deliberately did not write.
    await expect(readFile(project, "utf8")).resolves.toBe(original);
    await expect(readFile(join(fixture.workspace, "AGENTS.md"), "utf8")).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );

    const before = await snapshot(fixture.workspace);
    await expect(runSetup(fixture.request(registry, skipProjectInstructions()))).resolves.toBe(0);
    await expect(snapshot(fixture.workspace)).resolves.toEqual(before);
  });

  it("declines only the scope that consolidates nothing, leaving the run and its other scope intact", async () => {
    const fixture = await createFixture();
    const project = join(fixture.workspace, "CLAUDE.md");
    await writeFile(project, "# Project\n\nUse the repository verification command.\n", "utf8");
    await mkdir(join(fixture.homeDir, ".claude"), { recursive: true });
    await writeFile(join(fixture.homeDir, ".claude", "CLAUDE.md"), "# Claude\n\nGlobal.\n", "utf8");
    const registry = createPluginRegistry([consolidationPlugin(), projectConsolidationPlugin()], {
      bareCheckIdPlugins: ["checks-core"],
    });

    // Consolidating an empty selection used to raise a blocker, which aborts the whole run with
    // exit 2 and writes nothing anywhere — including the global scope the user did configure.
    await expect(runSetup(fixture.request(registry, emptyProjectSelection()))).resolves.toBe(0);

    await expect(readFile(join(fixture.homeDir, "agents", "AGENTS.md"), "utf8")).resolves.toContain(
      "# Instructions from ~/.claude/CLAUDE.md",
    );
    // Named as work to do, not as a fact about the run: it renders under "Steps to take yourself".
    expect(fixture.output()).toContain("select at least one project source to consolidate");
    await expect(readFile(join(fixture.workspace, "AGENTS.md"), "utf8")).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  });

  it("blocks rather than quietly declining the global scope when it consolidates nothing", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspace, "CLAUDE.md"), "# Project\n\nRules.\n", "utf8");
    await mkdir(join(fixture.homeDir, ".claude"), { recursive: true });
    await writeFile(join(fixture.homeDir, ".claude", "CLAUDE.md"), "# Claude\n\nGlobal.\n", "utf8");
    const registry = createPluginRegistry([consolidationPlugin(), projectConsolidationPlugin()], {
      bareCheckIdPlugins: ["checks-core"],
    });

    // The action menu withholds its opt-out from the global scope because INS-001 and INS-002 fail
    // a run without a shared source. An empty selection must not be the way around that: applying
    // the rest of the plan and ending red is worse than refusing the plan and saying why.
    await expect(runSetup(fixture.request(registry, emptyGlobalSelection()))).resolves.toBe(2);

    expect(fixture.output()).toContain("Select a source, or choose the starter template");
    await expect(
      readFile(join(fixture.homeDir, "agents", "AGENTS.md"), "utf8"),
    ).rejects.toHaveProperty("code", "ENOENT");
    await expect(readFile(join(fixture.workspace, "AGENTS.md"), "utf8")).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
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

function skipProjectInstructions(): readonly WizardAnswers[] {
  return repeatedAnswers({ "project-instruction-action": { kind: "options", values: ["skip"] } });
}

function skipGlobalInstructions(): readonly WizardAnswers[] {
  return repeatedAnswers({ "global-instruction-action": { kind: "options", values: ["skip"] } });
}

/** Consolidate chosen for the project scope, then every source unchecked on the Sources form. */
function emptyProjectSelection(): readonly WizardAnswers[] {
  return repeatedAnswers({
    "project-instruction-action": { kind: "options", values: ["consolidate"] },
    "project-instruction-sources": { kind: "options", values: [] },
  });
}

/** The same empty Sources form, on the scope that has no opt-out to fall back to. */
function emptyGlobalSelection(): readonly WizardAnswers[] {
  return repeatedAnswers({
    "global-instruction-action": { kind: "options", values: ["consolidate"] },
    "global-instruction-sources": { kind: "options", values: [] },
  });
}
